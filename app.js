var express = require("express");
var session = require("express-session");
var path = require('path');
var swig = require('swig');
var q = require('q');
var logger = require('morgan');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var mongoClient = require('mongodb').MongoClient;

var GithubEvents = require("./routes/githubEvents");
var MongoRepository = require('./routes/mongoRepository');
var GithubOAuth = require("./routes/githubOAuth");
var QdService = require("./routes/qdService");
var app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(logger());
app.use(cookieParser());
app.use(bodyParser.urlencoded({
    extended: true
}));

var winston = require('winston');
winston.add(winston.transports.File, { filename: 'github-datasource.log', level: 'debug', json: false });
winston.level = 'info';
winston.error('Errors will be logged here');
winston.warn('Warns will be logged here');
winston.info('Info will be logged here');
winston.verbose('Verbose will be logged here');
winston.debug('Debug will be logged here');
winston.silly('Silly will be logged here');

winston.info('DBURI=' + process.env.DBURI);
var mongoUri = process.env.DBURI;

winston.info('PORT=' + process.env.PORT);
var port = process.env.PORT || 5001;

winston.info('SESSION_SECRET=' + process.env.SESSION_SECRET.substring(0,2) + '...');
var sessionSecret = process.env.SESSION_SECRET;

var logInfo = function(req, username, message, object){
  req.logger.info(username + ': ' + message, object);
}

var logDebug = function(req, username, message, object){
  req.logger.debug(username + ': ' + message, object);
}

var logError = function(req, username, message, object){
  req.logger.error(username + ': ' + message, object);
}

app.use(session({
    secret: sessionSecret,
    cookie: {
        maxAge: 2 * 365 * 24 * 60 * 60 * 1000, // 2 years
        secure: false // change to true when using https
    },
    resave: false, // don't save session if unmodified
    saveUninitialized: false // don't create session until something stored
}));

app.use(bodyParser.json());
app.engine('html', swig.renderFile);
app.set('views', __dirname + '/views');
app.set('view engine', 'html');

var attachLogger = function(req, res, next){
    req.logger = winston;
    next();
};
app.use(attachLogger);

var server = app.listen(port, function () {
    console.log("Listening on " + port);
});

var qdService = new QdService();

var mongoRepository;
var githubEvents;
var githubOAuth;
mongoClient.connect(mongoUri, function (err, databaseConnection) {
    if (err) {
        console.error("Could not connect to Mongodb with URI : " + mongoUri);
        console.error(err);
        process.exit(1);
    } else {
        console.log("connected to mongo : ", mongoUri);
        mongoRepository = new MongoRepository(databaseConnection);
        githubEvents = new GithubEvents(mongoRepository, qdService);
        githubOAuth = new GithubOAuth(app, mongoRepository, qdService);
    }
});

app.get("/", function (req, res) {
    process.env.integrationUrl = req.headers.hostname;
    req.session.oneselfUsername = req.query.username;
    req.session.registrationToken = req.query.token;
    logInfo(req, req.query.username, 'github setup started: integrationUrl, registrationToken', req.headers.hostname, req.query.token);
    res.render('index');
});

app.get("/authSuccess", function (req, res) {
        var githubUsername = req.query.username;
        var streamInfo = {
            streamid: req.query.streamid,
            writeToken: req.headers.authorization,
            lastSyncDate: req.query.latestSyncField
        };
        mongoRepository.findByGithubUsername(githubUsername)
            .then(function (user) {
                var userInfo = {
                    githubUsername: githubUsername,
                    accessToken: user.accessToken
                };
                return githubEvents.sendGithubEvents(userInfo, streamInfo);
            });
        res.status(200).send("ok");
    }
);