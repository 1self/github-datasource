var request = require("request");
var passport = require('passport');
var githubStrategy = require('passport-github').Strategy;
var _ = require('underscore');

var GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
var GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
var CONTEXT_URI = process.env.CONTEXT_URI;

module.exports = function (app, mongoRepository, oneselfService) {

    var handleGithubCallback = function (req, res) {
        var githubUser = req.user.profile;
        var githubUsername = githubUser.username;
        req.session.accessToken = req.user.accessToken;
        req.session.githubUsername = githubUsername;
        console.log("github User is : " + JSON.stringify(githubUser));
        var callbackUrl = 'http://gitplugin.com:5001/authSuccess?username=' + githubUsername
            + '&latestSyncField={{latestSyncField}}'
            + '&streamid={{streamid}}';

        var document = {
            githubUsername: githubUsername,
            accessToken: req.user.accessToken
        };
        mongoRepository.insert(document).then(function () {
            return oneselfService.registerStream(callbackUrl)
        }).then(function (stream) {
            var callbackUrlForUser = callbackUrl
                .replace('{{streamid}}', stream.streamid)
                .replace('{{latestSyncField}}', new Date(1970, 1, 1).toISOString());
            request({
                method: 'POST',
                uri: callbackUrlForUser,
                gzip: true,
                headers: {
                    'Authorization': stream.writeToken
                }
            }, function (e, response, body) {
            });
            var redirectUrl = process.env.DASHBOARD_URI;
            res.redirect(redirectUrl + "?streamId=" + stream.streamid + "&readToken=" + stream.readToken);
        }).catch(function (error) {
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
            callbackURL: CONTEXT_URI + "/auth/github/callback"
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
        failureRedirect: CONTEXT_URI
    }), handleGithubCallback);
}
;
