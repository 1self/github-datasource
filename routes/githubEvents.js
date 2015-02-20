var _ = require("underscore");
var github = require('octonode');
var moment = require('moment');
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
    var fetchGithubPushEvents = function (userInfo, streamInfo) {
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
                "properties": {}
            };
            return clone(singleEventTemplate);
        };

        return _.map(filteredEvents, convertEventTo1SelfFormat);
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
            "objectTags": ["sync"],
            "actionTags": ["start"],
            "properties": {
                "source": "GitHub"
            }
        };
    };
    var createSyncCompleteEvent = function () {
        return {
            "dateTime": moment().toISOString(),
            "objectTags": ["sync"],
            "actionTags": ["complete"],
            "properties": {
                "source": "GitHub"
            }
        };
    };

    this.sendGithubEvents = function (userInfo, streamInfo) {
        var syncStartEvent = createSyncStartEvent();
        qdService.sendEvent(syncStartEvent, streamInfo)
            .then(function () {
                return fetchGithubPushEvents(userInfo, streamInfo)
            })
            .then(function (events) {
                return filterEventsToBeSent(events, streamInfo.lastSyncDate);
            })
            .then(convertEventsTo1SelfFormat)
            .then(function (eventsToBeSent) {
                return sendEventsToQD(eventsToBeSent, streamInfo);
            })
            .then(function () {
                var syncCompleteEvent = createSyncCompleteEvent();
                return qdService.sendEvent(syncCompleteEvent, streamInfo);
            });
    };
};
