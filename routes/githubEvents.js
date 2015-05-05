var _ = require("underscore");
var github = require('octonode');
var moment = require('moment');
var request = require('request');
var Q = require('q');

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

        var convertEventTo1SelfFormat = function (event) {
            var clone = function (obj) {
                return JSON.parse(JSON.stringify(obj));
            };
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
                        "Source Control"
                    ],
                    "dateTime": moment(event.created_at).toISOString(),
                    "latestSyncField": {
                        "$date": moment(event.created_at).toISOString()
                    },
                    "properties": {
                        "pushId": event.payload["push_id"],
                        "commitIds": _.map(event.payload.commits, function (c) {
                            return c['sha']
                        })
                    }
                };
            } else if (event.commit != undefined) {
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
                    "dateTime": moment(event.created_at).toISOString(),
                    "latestSyncField": {
                        "$date": moment(event.created_at).toISOString()
                    },
                    "properties": {
                        "pushId": event.pushId,
                        "sha": event.sha,
                        "author-name": event.commit.author.name,
                        "author-email": event.commit.author.email,
                        "author-date": event.commit.author.date,
                        "message": event.commit.message,
                        "url": event.commit.url,
                        "line-changes": event.stats.total,
                        "line-additions": event.stats.additions,
                        "line-deletions": event.stats.deletions,
                        "file-changes": _.reduce(event.files, function (s, e) {
                            return s + e.changes
                        }, 0),
                        "file-additions": _.reduce(event.files, function (s, e) {
                            return s + e.additions
                        }, 0),
                        "file-deletions": _.reduce(event.files, function (s, e) {
                            return s + e.deletions
                        }, 0)
                    }
                };
            } else {
                console.log("ERROR commit ---->", JSON.stringify(event))
            }
            return clone(singleEventTemplate);
        };
        var mappedEvents = _.map(filteredEvents, convertEventTo1SelfFormat);

        console.log("MAPPED EVENTS", mappedEvents);

        return mappedEvents;
    };

    var sendEventsToQD = function (events, streamInfo) {
        var deferred = Q.defer();
        if (_.isEmpty(events)) {
            deferred.resolve();
        }
        qdService.sendBatchEvents(events, streamInfo)
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
            "objectTags": ["1self integration sync"],
            "actionTags": ["start"],
            "source": "1self-GitHub",
            "properties": {
            }
        };
    };
    var createSyncCompleteEvent = function () {
        return {
            "dateTime": moment().toISOString(),
            "objectTags": ["1self integration sync"],
            "actionTags": ["complete"],
            "source": "1self-GitHub",
            "properties": {
            }
        };
    };

    var getGithubCommitEvents = function (filteredEvents, userInfo) {
        console.log("In getGithubCommitEvents")
        var deferred = Q.defer();

        var commitObjects = [];
        _.each(filteredEvents, function (event) {
            _.each(event.payload.commits, function (commit) {
                commitObjects.push({url: commit['url'], pushId: event.payload["push_id"]})
            })
        });

        var getCommitPromise = function (commitObject) {
            var deferred = Q.defer();
            console.log("Hitting request")
            var url = commitObject.url + "?access_token=" + userInfo.accessToken;
            console.log("Hitting url", url);
            var options = {
                url: url,
                headers: {
                    "User-Agent": "1self"
                }
            };

            request(options, function (err, res, body) {
                if (!err) {
                    var commit = JSON.parse(body);
                    commit.pushId = commitObject.pushId
                    deferred.resolve(commit);
                }
                else {
                    console.log("Error occurred :: getCommitPromise", err);
                    deferred.reject(err);
                }
            });
            return deferred.promise;
        };

        var promiseArray = [];

        _.map(commitObjects, function (commitObject) {
            promiseArray.push(getCommitPromise(commitObject))
        });

        Q.all(promiseArray).then(function (commitEvents) {
            var events = filteredEvents.concat(commitEvents)
            deferred.resolve(events);
        }).catch(function (error) {
            console.log("Error occurred :: getGithubCommitEvents", error);
        });

        return deferred.promise;
    };

    this.sendGithubEvents = function (userInfo, streamInfo) {
        var syncStartEvent = createSyncStartEvent();

        qdService.sendEvent(syncStartEvent, streamInfo)
            .then(function () {
                return fetchGithubPushEvents(userInfo)
            })
            .then(function (events) {
                return filterEventsToBeSent(events, streamInfo.lastSyncDate);
            })
            .then(function (filteredEvents) {
                return getGithubCommitEvents(filteredEvents, userInfo)
            }).then(convertEventsTo1SelfFormat)
            .then(function (eventsToBeSent) {
                return sendEventsToQD(eventsToBeSent, streamInfo);
            })
            .then(function () {
                var syncCompleteEvent = createSyncCompleteEvent();
                return qdService.sendEvent(syncCompleteEvent, streamInfo);
            }).catch(function (error) {
                console.error("Error occurred :: sendGithubEvents ", error)
            });
    };
}
;
