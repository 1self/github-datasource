var requestModule = require('request');
var Q = require('q');

module.exports = function () {
    var appId = process.env.APP_ID;
    var appSecret = process.env.APP_SECRET;
    var oneselfUri = process.env.ONESELF_URI;

    this.registerStream = function (oneselfUsername, token, callbackUrl) {
        var deferred = Q.defer();
        console.log("Registering stream...");

        var options = {
            method: 'POST',
            uri: oneselfUri + '/v1/users/' + oneselfUsername + '/streams',
            headers: {
                'Authorization': appId + ':' + appSecret,
                'registration-token': token
            },
            json: true,
            body: {
                callbackUrl: callbackUrl
            }
        };
        requestModule(options, function (e, response, body) {
            if (response.statusCode === 401) {
                deferred.reject('auth error: check your appId and appSecret', null);
                return;
            }
            if (response.statusCode === 400) {
                deferred.reject('Invalid username and registrationToken', null);
                return;
            }
            if (e) {
                deferred.reject("Error: ", e);
            }
            deferred.resolve(body);
        });
        return deferred.promise;
    };

    this.sendBatchEvents = function (events, streamInfo) {
        var deferred = Q.defer();
        var options = {
            method: 'POST',
            uri: oneselfUri + '/v1/streams/' + streamInfo.streamid + '/events/batch',
            gzip: true,
            headers: {
                'Authorization': streamInfo.writeToken,
                'Content-type': 'application/json'
            },
            json: true,
            body: events
        };
        requestModule(options, function (err, response, body) {
            if (err) {
                deferred.reject(err);
            }
            if (response.statusCode === 404) {
                deferred.reject("Stream Not Found!")
            }
            deferred.resolve();
        });
        return deferred.promise;
    };

    this.sendEvent = function (event, streamInfo) {
        var deferred = Q.defer();
        var options = {
            method: 'POST',
            uri: oneselfUri + '/v1/streams/' + streamInfo.streamid + '/events',
            gzip: true,
            headers: {
                'Authorization': streamInfo.writeToken,
                'Content-type': 'application/json'
            },
            json: true,
            body: event
        };
        requestModule(options, function (err, response, body) {
            if (err) {
                deferred.reject(err);
            }
            if (response.statusCode === 404) {
                deferred.reject("Stream Not Found!")
            }
            deferred.resolve();
        });
        return deferred.promise;
    };

    this.validateUser = function (username, token) {
        var deferred = Q.defer();
        var options = {
            method: 'GET',
            uri: oneselfUri + '/v1/validate/user?username=' + username,
            headers: {
                'Authorization': token
            },
            json: true
        };
        requestModule(options, function (e, response, body) {
            if (response.statusCode === 401) {
                deferred.reject('Token incorrect', null);
                return;
            }
            if (e || response.statusCode === 500) {
                deferred.reject("Error: ", e);
            }
            deferred.resolve(true);
        });
        return deferred.promise;
    };
};
