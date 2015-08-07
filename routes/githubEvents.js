var _ = require('underscore');
var github = require('octonode');
var moment = require('moment');
var request = require('request');
var Q = require('q');
var path = require('path');

module.exports = function (mongoRepository, qdService) {

    var logger;

    var getGithubPushEventsPerPage = function (page, userInfo) {
        
        var githubUsername = userInfo.githubUsername;
        var user_api_url = '/users/' + githubUsername;
        var client = github.client(userInfo.accessToken);
        logger.logDebug(userInfo.githubUsername, 'fetching page [page, user_api_url, accessToken]', [page, user_api_url, userInfo.accessToken.substring(0,2)]);
        client.get(user_api_url, {}, function (err, status, body, headers) {
        });
        var githubUser = client.user(githubUsername);

        var deferred = Q.defer();
        githubUser.events(page, ['PushEvent'], function (err, pushEvents) {
            if (err) {
                logger.logError(githubUsername, 'err ' + err);
                deferred.reject(err);
            } else {
                deferred.resolve(pushEvents);
            }
        });
        return deferred.promise;
    };

    var fetchGithubPushEvents = function (userInfo) {
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

    var filterEventsToBeSent = function (userInfo, events, lastSyncDate) {
        logger.logDebug(userInfo.githubUsername, 'filtering events, [event count, lastSyncDate]', [events.length, lastSyncDate]);
        var eventsToBeSent = function (event) {
            return moment(event.created_at).isAfter(lastSyncDate);
        };
        var result = _.filter(events, eventsToBeSent);
        logger.logDebug(userInfo.githubUsername, 'events filtered, [event count]', [events.length]);
        return result;
    };

    var convertEventsTo1SelfFormat = function (filteredEvents, username) {
        var deferred = Q.defer();
        var convertEventTo1SelfFormat = function (acc, event) {
            logger.logSilly(username, 'converting raw event: ', event);
            if (event.type == 'PushEvent') {
                var singleEventTemplate = {
                    'actionTags': [
                        'Github',
                        'Push'
                    ],
                    'source': 'GitHub',
                    'objectTags': [
                        'Computer',
                        'Software',
                        'Source',
                        'Control'
                    ],
                    'id': event.payload['push_id'],
                    'childIds': _.map(event.payload.commits, function (c) {
                            return c['sha']
                        }),
                    'dateTime': moment(event.created_at).toISOString(),
                    'latestSyncField': {
                        '$date': moment(event.created_at).toISOString()
                    },
                    'properties': {
                        'commits': event.payload.size,
                        'repo': event.repo.name
                    }
                };

                logger.logSilly(username, 'converted push event: ', singleEventTemplate);
                return acc.concat(singleEventTemplate);

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
                    'actionTags': [
                        'commit'
                    ],
                    'source': 'GitHub',
                    'objectTags': [
                        'git',
                        'github',
                        'computer',
                        'software',
                        'source control'
                    ],
                    'dateTime': moment(event.commit.author.date).toISOString(),
                    'latestSyncField': {
                        '$date': moment(event.commit.author.date).toISOString()
                    },
                    'id': event.sha,
                    'parentId': event.pushId,
                    'url': event.commit.url,
                    'info': {
                        'message': event.commit.message,
                        'author-name': event.commit.author.name,
                        'author-email': event.commit.author.email,
                        'author-date': event.commit.author.date
                    },
                    'properties': {
                        'line-changes': event.stats.total,
                        'line-additions': event.stats.additions,
                        'line-deletions': event.stats.deletions,
                        'file-changes': event.files.length,
                        'repo': event.repo,
                        'file-types': extensionStats
                    }
                }
                
                if(event.committerIsAuthor === false){
                    singleEventTemplate.actionTags = ['merge'];
                }

                if (event.commit.author.email !== event.commit.committer.email) {
                    singleEventTemplate.actionTags = ['patch']
                }

                logger.logSilly(username, 'converted commit event: ', singleEventTemplate);
                
                return acc.concat(singleEventTemplate)
            } 
            else {
                logger.logSilly(username, 'couldnt convert as event is not a push or commit');
                return acc;
            }
        };

        var mappedEvents = _.reduce(filteredEvents, convertEventTo1SelfFormat, []);
        logger.logDebug(username, 'mapped events to 1self format, [event count]', mappedEvents.length);

        return mappedEvents;
    };

    var sendEventsToQD = function (events, streamInfo, appUri, userInfo) {
        var deferred = Q.defer();
        if (_.isEmpty(events)) {
            logger.logDebug(userInfo.githubUsername, 'there are no events to send');
            deferred.resolve();
        }

        logger.logDebug(userInfo.githubUsername, 'sending events to qd [event count, app uri]', [events.length, appUri]);
        qdService.sendBatchEvents(events, streamInfo, appUri)
            .then(function () {
                logger.logDebug(userInfo.githubUsername, 'events sent to 1self, [event count, stream info]', [events.length, streamInfo]);
                deferred.resolve();
            }, function (error) {
                logger.logError(userInfo.githubUsername, 'error while sending events', error);
                deferred.reject(error);
            });
        return deferred.promise;
    };

    var createSyncStartEvent = function () {
        return {
            'dateTime': moment().toISOString(),
            'objectTags': ['1self', 'integration', 'sync'],
            'actionTags': ['start'],
            'source': '1self-GitHub',
            'properties': {}
        };
    };

    var createSyncCompleteEvent = function () {
        return {
            'dateTime': moment().toISOString(),
            'objectTags': ['1self', 'integration', 'sync'],
            'actionTags': ['complete'],
            'source': '1self-GitHub',
            'properties': {}
        };
    };

    var getGithubCommitEvents = function (filteredEvents, userInfo) {
        logger.logDebug(userInfo.githubUsername, 'getting commit events for push events, [event count]', filteredEvents.length);
        var deferred = Q.defer();

        var commitObjects = [];

        var userEmailParts = /(.*?)(\+.*?)?(@.*)/g.exec(userInfo.email);
        var userEmail = userEmailParts[1] + userEmailParts[3];

        logger.logDebug(userInfo.githubUsername, 'flattening commits');
        logger.logDebug(userInfo.githubUsername, 'removing push email alias, [original, unaliased]', [userInfo.email, userEmail]);


        _.each(filteredEvents, function (event) {
            _.each(event.payload.commits, function (commit) {
                var commitReq = {
                    url: commit['url'], 
                    pushId: event.payload['push_id'], 
                    repo: event.repo.name
                }

                var commitEmailParts = /(.*?)(\+.*?)?(@.*)/g.exec(commit.author.email);
                var commitEmail = commitEmailParts[1] + commitEmailParts[3];
                commitReq.committerIsAuthor = commitEmail === userEmail;
                logger.logDebug(userInfo.githubUsername, 'commit req', commitReq);
                commitObjects.push(commitReq);
            })
        });

        logger.logDebug(userInfo.githubUsername, 'commit have been flattened, [commits]', commitObjects);

        // the delay is in there as the github api is returning an error when hit with lots of requests
        // quickly.
        var getCommitPromise = function (commitObject, delay) {
            var deferred = Q.defer();
            var url = commitObject.url + '?access_token=' + userInfo.accessToken;
            var options = {
                url: url,
                headers: {
                    'User-Agent': '1self'
                }
            };

            setTimeout(function(){
                logger.logDebug(userInfo.githubUsername, [options.url, 'requesting commit, [options, delay]'].join(': '), [options, delay]);
                request(options, function (err, res, body) {
                    if (!err) {
                        logger.logDebug(userInfo.githubUsername, [options.url, 'request successful'].join(': '));
                        var commit = JSON.parse(body);
                        commit.pushId = commitObject.pushId;
                        commit.repo = commitObject.repo;
                        commit.committerIsAuthor = commitObject.committerIsAuthor;
                        deferred.resolve(commit);
                    }
                    else {
                        logger.logDebug(userInfo.githubUsername, [options.url, 'request failed, [error]'].join(': '), err);
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
            logger.logDebug(userInfo.githubUsername, 'all commit events retrieved');
            var events = filteredEvents.concat(commitEvents)
            deferred.resolve(events);
        }).catch(function (error) {
            logger.logError(userInfo.githubUsername, 'Error occurred :: getGithubCommitEvents', error);
        });

        return deferred.promise;
    };

    this.sendGithubEvents = function (userInfo, streamInfo, appUri) {
        logger.logInfo(userInfo.githubUsername, 'starting sync, sending start sync event');
        var syncStartEvent = createSyncStartEvent();

        qdService.sendEvent(syncStartEvent, streamInfo, appUri)
            .then(function () {
                logger.logInfo(userInfo.githubUsername, 'fetching events from github api', []);
                return fetchGithubPushEvents(userInfo)
            })
            .then(function (events) {
                logger.logInfo(userInfo.githubUsername, 'filtering events to include only pushes, [event count]', [events.length]);
                return filterEventsToBeSent(userInfo, events, streamInfo.lastSyncDate);
            })
            .then(function (filteredEvents) {
                logger.logInfo(userInfo.githubUsername, 'getting the commit events for the pushes, [event count]', filteredEvents.length);
                return getGithubCommitEvents(filteredEvents, userInfo);
            })
            .then(function (filteredEvents){
                logger.logInfo(userInfo.githubUsername, 'converting events to 1self format, [event count]', filteredEvents.length);
                return convertEventsTo1SelfFormat(filteredEvents, userInfo.githubUsername);
            })
            .then(function (eventsToBeSent) {
                logger.logInfo(userInfo.githubUsername, 'sending the events to 1self, [event count]', eventsToBeSent.length);
                return sendEventsToQD(eventsToBeSent, streamInfo, appUri, userInfo);
            })
            .then(function () {
                logger.logInfo(userInfo.githubUsername, 'sending sync complete to 1self', []);
                var syncCompleteEvent = createSyncCompleteEvent();
                return qdService.sendEvent(syncCompleteEvent, streamInfo, appUri);
            })
            .then(function() {
                logger.logInfo(userInfo.githubUsername, 'finished sending events to 1self');
            })
            .catch(function (error) {
                logger.logError(userInfo.githubUsername, 'Error occurred :: sendGithubEvents', error);
            });
    };

    this.setLogger = function(newLogger){
        logger = newLogger;
    }

    
};
