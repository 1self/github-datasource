Cvar request = require("request");
var passport = require('passport');
var githubStrategy = require('passport-github').Strategy;
var _ = require('underscore');

var GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
var GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
var GITHUB_INT_CONTEXT_URI = process.env.GITHUB_INT_CONTEXT_URI;
var INTEGRATIONS_URL = process.env.CONTEXT_URI + '/integrations';

module.exports = function (app, mongoRepository, oneselfService) {

    var handleGithubCallback = function (req, res) {
        var githubUser = req.user.profile;
        var githubUsername = githubUser.username;
        req.session.accessToken = req.user.accessToken;
        req.session.githubUsername = githubUsername;
        var oneselfUsername = req.session.oneselfUsername;
        var registrationToken = req.session.registrationToken;
        console.log("github User is : " + JSON.stringify(githubUser));
        var callbackUrl = GITHUB_INT_CONTEXT_URI + '/authSuccess?username=' + githubUsername
            + '&latestSyncField={{latestSyncField}}'
            + '&streamid={{streamid}}';

        var document = {
            githubUsername: githubUsername,
            accessToken: req.user.accessToken
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
                console.log("Synced github Events!!!");
            });
        };
        mongoRepository.findByGithubUsername(githubUsername)
            .then(function (user) {
                if (user && user.streamid) {
                    var callbackUrlForUser = callbackUrl
                        .replace('{{streamid}}', user.streamid)
                        .replace('{{latestSyncField}}', user.lastGithubSyncDate.toISOString());
                    console.log("Syncing github events");
                    syncGithubEvents(callbackUrlForUser, user.writeToken);
                    oneselfService.link(oneselfUsername, user.streamid)
                        .then(function () {
                            var findQuery = {
                                'githubUsername': githubUsername
                            };
                            var updateQuery = {
                                "$set": {
                                    "accessToken": req.user.accessToken
                                },
                                "$unset": {
                                    "streamid": 1,
                                    "readToken": 1,
                                    "writeToken": 1,
                                    "lastGithubSyncDate": 1
                                }
                            };
                            return mongoRepository.update(findQuery, updateQuery)
                        })
                        .then(function () {
                            res.redirect(INTEGRATIONS_URL);
                        });
                }
                else {
                    oneselfService.registerStream(oneselfUsername, registrationToken, callbackUrl)
                        .then(function (stream) {
                            mongoRepository.insert(document)
                                .then(function () {
                                    var callbackUrlForUser = callbackUrl
                                        .replace('{{streamid}}', stream.streamid)
                                        .replace('{{latestSyncField}}', new Date(1970, 1, 1).toISOString());
                                    syncGithubEvents(callbackUrlForUser, stream.writeToken);
                                    
                                    res.redirect(INTEGRATIONS_URL);
                                })
                        }, function (error) {
                            res.render('error', {
                                error: error
                            });
                        })
                }
            })
            .catch(function (error) {
                console.error("Error in github callback: ", error);
            });
    };

    passport.serializeUser(function (user, done) {
        done(null, user);
    });

    passport.deserializeUser(function (obj, done) {
        done(null, obj);
    });

    passport.use(new githubStrategy({
            clientID: GITHUB_CLIENT_ID,
            clientSecret: GITHUB_CLIENT_SECRET,
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
        scope: 'repo'
    }));

    app.get('/auth/github/callback', passport.authenticate('github', {
        failureRedirect: GITHUB_INT_CONTEXT_URI
    }), handleGithubCallback);
}
;
