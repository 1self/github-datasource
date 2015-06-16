var _ = require("underscore");
var github = require('octonode');
var moment = require('moment');
var request = require('request');
var Q = require('q');
var path = require('path');
var logger = require('winston');

var logInfo = function(username, message, object){
  logger.info(username + ': ' + message, object);
}

var logDebug = function(username, message, object){
  logger.debug(username + ': ' + message, object);
}

var logError = function(username, message, object){
  logger.error(username + ': ' + message, object);
}

module.exports = function (mongoRepository, qdService) {

    var getGithubPushEventsPerPage = function (page, userInfo) {
        logDebug(userInfo.githubUsername, "fetching page: ", page);
        var githubUsername = userInfo.githubUsername;
        var user_api_url = "/users/" + githubUsername;
        var client = github.client(userInfo.accessToken);
        client.get(user_api_url, {}, function (err, status, body, headers) {
        });
        var githubUser = client.user(githubUsername);

        var deferred = Q.defer();
        githubUser.events(page, ['PushEvent'], function (err, pushEvents) {
            if (err) {
                logError(githubUsername, "err " + err);
                deferred.reject(err);
            } else {
                deferred.resolve(pushEvents);
            }
        });
        return deferred.promise;
    };

    var fetchGithubPushEvents = function (userInfo) {
        logInfo(userInfo.githubUsername, "fetchGithubPushEvents", userInfo)
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

    var convertEventsTo1SelfFormat = function (filteredEvents, username) {
        var deferred = Q.defer();
        logDebug(username, 'converting events to 1self format');
        var convertEventTo1SelfFormat = function (acc, event) {
            logDebug(username, 'raw event: ', event);
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

                logDebug(username, 'converted push event: ', singleEventTemplate);
                return acc.concat(singleEventTemplate);

            } 
            else if (event.commit != undefined) {
                logDebug(username, 'raw event', event);
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
                
                if(event.committerIsAuthor === false){
                    singleEventTemplate.actionTags = ["merge"];
                }

                if (event.commit.author.email !== event.commit.committer.email) {
                    singleEventTemplate.actionTags = ["patch"]
                }

                logDebug(username, 'converted commit event: ', singleEventTemplate);
                
                return acc.concat(singleEventTemplate)
            } 
            else {
                logError(username, 'Error commit', event);
                logDebug(username, 'Error event', event);
                return acc;

            }
        };
        var mappedEvents = _.reduce(filteredEvents, convertEventTo1SelfFormat, []);

        console.log("MAPPED EVENTS", mappedEvents);

        return mappedEvents;
    };

    var sendEventsToQD = function (events, streamInfo, appUri, userInfo) {
        var deferred = Q.defer();
        if (_.isEmpty(events)) {
            deferred.resolve();
        }
        qdService.sendBatchEvents(events, streamInfo, appUri)
            .then(function () {
                logInfo(userInfo.githubUsername, 'Events sent to 1self', [events.length, streamInfo]);
                deferred.resolve();
            }, function (error) {
                logError(userInfo.githubUsername, 'Error while sending events', error);
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
        logDebug(userInfo.githubUsername, 'getting commit events, push events length: ', filteredEvents.length);
        var deferred = Q.defer();

        var commitObjects = [];

        var userEmailParts = /(.*?)(\+.*?)?(@.*)/g.exec(userInfo.email);
        var userEmail = userEmailParts[1] + userEmailParts[3];

        _.each(filteredEvents, function (event) {
            _.each(event.payload.commits, function (commit) {
                var commitReq = {
                    url: commit['url'], 
                    pushId: event.payload["push_id"], 
                    repo: event.repo.name
                }

                var commitEmailParts = /(.*?)(\+.*?)?(@.*)/g.exec(commit.author.email);
                var commitEmail = commitEmailParts[1] + commitEmailParts[3];
                commitReq.committerIsAuthor = commitEmail === userEmail;
                logDebug(userInfo.githubUsername, 'commit req', commitReq);
                commitObjects.push(commitReq);
            })
        });

        logDebug(userInfo.githubUsername, 'commit requests created: ', commitObjects);

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
                logDebug(userInfo.githubUsername, 'executing commit object request: ', options);
                request(options, function (err, res, body) {
                    if (!err) {
                        var commit = JSON.parse(body);
                        commit.pushId = commitObject.pushId;
                        commit.repo = commitObject.repo;
                        commit.committerIsAuthor = commitObject.committerIsAuthor;
                        deferred.resolve(commit);
                    }
                    else {
                        logDebug(userInfo.githubUsername, 'Error occurred getting commit: options, err: ', [options, err]);
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
            logDebug(userInfo.githubUsername, 'all commit events retrieved');
            var events = filteredEvents.concat(commitEvents)
            deferred.resolve(events);
        }).catch(function (error) {
            logError(userInfo.githubUsername, 'Error occurred :: getGithubCommitEvents', error);
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
                return getGithubCommitEvents(filteredEvents, userInfo);
            })
            .then(function (filteredEvents){
                return convertEventsTo1SelfFormat(filteredEvents, userInfo.githubUsername);
            })
            .then(function (eventsToBeSent) {
                return sendEventsToQD(eventsToBeSent, streamInfo, appUri, userInfo);
            })
            .then(function () {
                var syncCompleteEvent = createSyncCompleteEvent();
                return qdService.sendEvent(syncCompleteEvent, streamInfo, appUri);
            })
            .then(function() {
                logInfo(userInfo, 'finished sending events to 1self');
            })
            .catch(function (error) {
                logDebug(userInfo.githubUsername, 'Error occurred :: sendGithubEvents', error);
            });
    };
}
;
