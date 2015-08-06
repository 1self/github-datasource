var request = require("request");
var passport = require('passport');
var githubStrategy = require('passport-github').Strategy;
var _ = require('underscore');
var q = require('q');
var logger = require('winston');

var GITHUB_DATASOURCE_CLIENT_ID = process.env.GITHUB_DATASOURCE_CLIENT_ID;
var GITHUB_DATASOURCE_CLIENT_SECRET = process.env.GITHUB_DATASOURCE_CLIENT_SECRET;
var GITHUB_INT_CONTEXT_URI = process.env.GITHUB_INT_CONTEXT_URI;

var logInfo = function(username, message, object){
  logger.info(username + ': ' + message, object);
}

var logDebug = function(username, message, object){
  logger.debug(username + ': ' + message, object);
}

var logError = function(username, message, object){
  logger.error(username + ': ' + message, object);
}

logger.info('env');
logger.info(GITHUB_DATASOURCE_CLIENT_ID);
logger.info(GITHUB_DATASOURCE_CLIENT_SECRET);
logger.info(GITHUB_INT_CONTEXT_URI);

module.exports = function (app, mongoRepository, oneselfService) {

    var handleNewAuthCallback = function(req, res){
        var githubUser = req.user.profile;
        var githubUsername = githubUser.username;

        req.session.accessToken = req.user.accessToken;
        req.session.githubUsername = githubUsername;
        var oneselfUsername = req.session.oneselfUsername;
        var registrationToken = req.session.registrationToken;
        logDebug(githubUsername, "github User is: " + JSON.stringify(githubUser));
        var callbackUrl = GITHUB_INT_CONTEXT_URI + '/authSuccess?username=' + githubUsername
            + '&latestSyncField={{latestSyncField}}'
            + '&streamid={{streamid}}';

        // we use the display name to spot commits that weren't made by the committer. 
        // this can happen when a rebase occurs.
        var userInfo = {
            githubUsername: githubUsername,
            accessToken: req.user.accessToken,
            displayName: req.user.profile.displayName,
        };

        var getEmailAddress = function (accessToken) {
            var deferred = q.defer();
            var options = {
                url: "https://api.github.com/user/emails?access_token=" + accessToken,
                headers: {
                    "User-Agent": "1self"
                }
            };
            request(options, function (err, res, body) {
                if (!err) {
                    userInfo.email = JSON.parse(body)[0].email; 
                    logDebug(userInfo.githubUsername, 'email retrieved from users github profile', userInfo.email);
                    deferred.resolve();
                }
                else {
                    logDebug(userInfo.githubUsername, 'error trying to get email: ', err);                    
                    deferred.reject(err);
                }
            });
            return deferred.promise;
        };

        var syncGithubEvents = function (callbackUrl, writeToken) {

            request({
                method: 'GET',
                uri: callbackUrl,
                gzip: true,
                headers: {
                    'Authorization': writeToken
                }
            }, function (e, response, body) {
                console.log("Started event sync");
            });
        };

        getEmailAddress(req.session.accessToken)
        .then(function(){
            return mongoRepository.findByGithubUsername(userInfo.githubUsername);
        })
        .then(function (user) {
            // we hit this if we are doing a re-auth and the user already exists
            oneselfService.registerStream(oneselfUsername, registrationToken, req.session.appUri, callbackUrl)
                .then(function (stream) {
                    mongoRepository.insert(userInfo)
                        .then(function () {
                            var callbackUrlForUser = callbackUrl
                                .replace('{{streamid}}', stream.streamid)
                                .replace('{{latestSyncField}}', new Date(1970, 1, 1).toISOString());
                            syncGithubEvents(callbackUrlForUser, stream.writeToken);

                            res.redirect(req.session.appUri + "/integrations");
                        })
                }, function (error) {
                    res.render('error', {
                        error: error
                    });
                })
        })
        .catch(function (error) {
            logError(userInfo.githubUsername, "Error in github callback: ", error);
        });
    }

    var handleReauthCallback = function(req, res){
        var githubUser = req.user.profile;
        var githubUsername = githubUser.username;

        logDebug(githubUsername, "github User is: " + JSON.stringify(githubUser));
        var callbackUrl = GITHUB_INT_CONTEXT_URI + '/authSuccess?username=' + githubUsername
            + '&latestSyncField={{latestSyncField}}'
            + '&streamid={{streamid}}';

        var userInfo = {
            githubUsername: githubUsername,
            accessToken: req.user.accessToken,
            displayName: req.user.profile.displayName,
        };

        var getEmailAddress = function (accessToken) {
            var deferred = q.defer();
            var options = {
                url: "https://api.github.com/user/emails?access_token=" + accessToken,
                headers: {
                    "User-Agent": "1self"
                }
            };
            request(options, function (err, res, body) {
                if (!err) {
                    userInfo.email = JSON.parse(body)[0].email; 
                    logDebug(userInfo.githubUsername, 'email retrieved from users github profile', userInfo.email);
                    deferred.resolve();
                }
                else {
                    logDebug(userInfo.githubUsername, 'error trying to get email: ', err);                    
                    deferred.reject(err);
                }
            });
            return deferred.promise;
        };

        getEmailAddress(userInfo.accessToken)
        .then(function(){
            return mongoRepository.findByGithubUsername(githubUsername);
        })
        .then(function (user) {
            var query = {
                _id: user._id
            }

            var operation = {
                $set: {
                    accessToken: userInfo.accessToken,
                    email: userInfo.email
                }
            }
                
            mongoRepository.update(query, operation)
            .then(function () {
                res.redirect(req.session.redirect);
            })                
        })
        .catch(function (error) {
            logError(userInfo.githubUsername, "Error in github callback: ", error);
        });
    }
    var handleGithubCallback = function (req, res) {
        if(req.session.reauth){
            handleReauthCallback(req, res);
        }
        else{
            handleNewAuthCallback(req, res);
        }
    };

    passport.serializeUser(function (user, done) {
        done(null, user);
    });

    passport.deserializeUser(function (obj, done) {
        done(null, obj);
    });

    console.log(GITHUB_DATASOURCE_CLIENT_ID);
    console.log(GITHUB_DATASOURCE_CLIENT_SECRET);
    console.log(GITHUB_INT_CONTEXT_URI);
    passport.use(new githubStrategy({
            clientID: GITHUB_DATASOURCE_CLIENT_ID,
            clientSecret: GITHUB_DATASOURCE_CLIENT_SECRET,
            callbackURL: GITHUB_INT_CONTEXT_URI + "/auth/github/callback"
        },
        function (accessToken, refreshToken, profile, done) {
            var githubProfile = {
                profile: profile,
                accessToken: accessToken
            };
            return done(null, githubProfile);
        }
    ));
    app.use(passport.initialize());
    app.use(passport.session());

    app.get('/auth/github', passport.authenticate('github', {
        scope: 'repo,user:email'
    }));

    app.get('/auth/github/callback', passport.authenticate('github', {
        failureRedirect: GITHUB_INT_CONTEXT_URI,
    }), handleGithubCallback);
}
;
