var _ = require("underscore");
var github = require('octonode');
var moment = require('moment');
var request = require('request');
var Q = require('q');
var path = require('path');

module.exports = function (mongoRepository, qdService) {

    var getGithubPushEventsPerPage = function (page, userInfo) {
        var githubUsername = userInfo.githubUsername;
        var user_api_url = "/users/" + githubUsername;
        var client = github.client(userInfo.accessToken);
        client.get(user_api_url, {}, function (err, status, body, headers) {
        });
        var githubUser = client.user(githubUsername);

        var deferred = Q.defer();
        githubUser.events(page, ['PushEvent'], function (err, pushEvents) {
            if (err) {
                console.log("err " + err);
                deferred.reject(err);
            } else {
                deferred.resolve(pushEvents);
            }
        });
        return deferred.promise;
    };

    var fetchGithubPushEvents = function (userInfo) {
        console.log("fetchGithubPushEvents")
        var deferred = Q.defer();
        var pages = _.range(1, 11);
        var promiseArray = _.map(pages, function (page) {
            return getGithubPushEventsPerPage(page, userInfo);
        });
        Q.all(promiseArray)
            .then(_.flatten)
            .then(function (events) {
                deferred.resolve(events);
            });
        return deferred.promise;
    };
    var filterEventsToBeSent = function (events, lastSyncDate) {
        var eventsToBeSent = function (event) {
            return moment(event.created_at).isAfter(lastSyncDate);
        };
        return _.filter(events, eventsToBeSent);
    };

    var convertEventsTo1SelfFormat = function (filteredEvents) {

        var convertEventTo1SelfFormat = function (acc, event) {

            if (event.type == "PushEvent") {
                var singleEventTemplate = {
                    "actionTags": [
                        "Github",
                        "Push"
                    ],
                    "source": "GitHub",
                    "objectTags": [
                        "Computer",
                        "Software",
                        "Source",
                        "Control"
                    ],
                    "id": event.payload["push_id"],
                    "childIds": _.map(event.payload.commits, function (c) {
                            return c['sha']
                        }),
                    "dateTime": moment(event.created_at).toISOString(),
                    "latestSyncField": {
                        "$date": moment(event.created_at).toISOString()
                    },
                    "properties": {
                        "commits": event.payload.size,
                        "repo": event.repo.name
                    }
                };
                return acc.concat(singleEventTemplate)

            } 
            else if (event.commit != undefined) {
                var extensionStats = _.reduce(event.files, function(result, file){
                    var ext = path.extname(file.filename).substring(1);
                    result[ext] = result[ext] || {};
                    result[ext]['line-additions'] = (result[ext]['line-additions'] || 0) + file['additions'];
                    result[ext]['line-deletions'] = (result[ext]['line-deletions'] || 0) + file['deletions'];
                    result[ext]['line-changes'] = (result[ext]['line-changes'] || 0) + file['changes'];
                    return result;
                }, {});
                var singleEventTemplate = {
                    "actionTags": [
                        "commit"
                    ],
                    "source": "GitHub",
                    "objectTags": [
                        "git",
                        "github",
                        "computer",
                        "software",
                        "source control"
                    ],
                    "dateTime": moment(event.commit.author.date).toISOString(),
                    "latestSyncField": {
                        "$date": moment(event.commit.author.date).toISOString()
                    },
                    "id": event.sha,
                    "parentId": event.pushId,
                    "url": event.commit.url,
                    "properties": {
                        "author-name": event.commit.author.name,
                        "author-email": event.commit.author.email,
                        "author-date": event.commit.author.date,
                        "message": event.commit.message,
                        "line-changes": event.stats.total,
                        "line-additions": event.stats.additions,
                        "line-deletions": event.stats.deletions,
                        "file-changes": event.files.length,
                        "repo": event.repo,
                        "file-types": extensionStats
                    }
                }
                
                if (event.commit.author.email !== event.commit.committer.email) {
                    singleEventTemplate.actionTags = ["patch"]
                }
                
                return acc.concat(singleEventTemplate)
            } 
            else {
                console.log("ERROR commit ---->", JSON.stringify(event))
                return acc;

            }
        };
        var mappedEvents = _.reduce(filteredEvents, convertEventTo1SelfFormat, []);

        console.log("MAPPED EVENTS", mappedEvents);

        return mappedEvents;
    };

    var sendEventsToQD = function (events, streamInfo, appUri) {
        var deferred = Q.defer();
        if (_.isEmpty(events)) {
            deferred.resolve();
        }
        qdService.sendBatchEvents(events, streamInfo, appUri)
            .then(function () {
                console.log("Events sent to 1self!!!");
                deferred.resolve();
            }, function (error) {
                deferred.reject(error);
            });
        return deferred.promise;
    };
    var createSyncStartEvent = function () {
        return {
            "dateTime": moment().toISOString(),
            "objectTags": ["1self", "integration", "sync"],
            "actionTags": ["start"],
            "source": "1self-GitHub",
            "properties": {}
        };
    };
    var createSyncCompleteEvent = function () {
        return {
            "dateTime": moment().toISOString(),
            "objectTags": ["1self", "integration", "sync"],
            "actionTags": ["complete"],
            "source": "1self-GitHub",
            "properties": {}
        };
    };

    var getGithubCommitEvents = function (filteredEvents, userInfo) {
        console.log("In getGithubCommitEvents")
        var deferred = Q.defer();

        var commitObjects = [];

        _.each(filteredEvents, function (event) {
            _.each(event.payload.commits, function (commit) {
                if(commit.author.name !== userInfo.displayName && commit.author.name !== userInfo.githubUsername){
                    console.log("" + userInfo.githubUsername + ": ignoring commit for " + commit.author.name);
                    return;
                }
                commitObjects.push({url: commit['url'], pushId: event.payload["push_id"], repo: event.repo.name})
            })
        });

        var getCommitPromise = function (commitObject, delay) {
            var deferred = Q.defer();
            var url = commitObject.url + "?access_token=" + userInfo.accessToken;
            var options = {
                url: url,
                headers: {
                    "User-Agent": "1self"
                }
            };

            setTimeout(function(){
                request(options, function (err, res, body) {
                    if (!err) {
                        var commit = JSON.parse(body);
                        commit.pushId = commitObject.pushId;
                        commit.repo = commitObject.repo;
                        deferred.resolve(commit);
                    }
                    else {
                        console.log("Error occurred :: getCommitPromise", err);
                        deferred.reject(err);
                    }
                }).end();
            }, 
            delay);
            return deferred.promise;
        };

        var promiseArray = [];

        _.map(commitObjects, function (commitObject, i) {
                promiseArray.push(getCommitPromise(commitObject, i * 100));
        });

        Q.all(promiseArray).then(function (commitEvents) {
            var events = filteredEvents.concat(commitEvents)
            deferred.resolve(events);
        }).catch(function (error) {
            console.log("Error occurred :: getGithubCommitEvents", error);
        });

        return deferred.promise;
    };

    this.sendGithubEvents = function (userInfo, streamInfo, appUri) {
        var syncStartEvent = createSyncStartEvent();

        qdService.sendEvent(syncStartEvent, streamInfo, appUri)
            .then(function () {
                return fetchGithubPushEvents(userInfo)
            })
            .then(function (events) {
                return filterEventsToBeSent(events, streamInfo.lastSyncDate);
            })
            .then(function (filteredEvents) {
                return getGithubCommitEvents(filteredEvents, userInfo)
            })
            .then(convertEventsTo1SelfFormat)
            .then(function (eventsToBeSent) {
                return sendEventsToQD(eventsToBeSent, streamInfo, appUri);
            })
            .then(function () {
                var syncCompleteEvent = createSyncCompleteEvent();
                return qdService.sendEvent(syncCompleteEvent, streamInfo, appUri);
            }).catch(function (error) {
                console.error("Error occurred :: sendGithubEvents ", error)
            });
    };
}
;
