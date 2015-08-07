/*jslint node: true */
var express = require('express');
var session = require('express-session');
var path = require('path');
var swig = require('swig');
var q = require('q');
var logger = require('morgan');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var mongoClient = require('mongodb').MongoClient;

var GithubEvents = require('./routes/githubEvents');
var MongoRepository = require('./routes/mongoRepository');
var GithubOAuth = require('./routes/githubOAuth');
var QdService = require('./routes/qdService');
var app = express();

/*jslint nomen: true */
app.use(express.static(path.join(__dirname, 'public')));
/*jslint nomen: false */

app.use(logger());
app.use(cookieParser());
app.use(bodyParser.urlencoded({
    extended: true
}));


var winston = require('winston');
var filename = process.env.LOGGINGDIR ? path.join(process.env.LOGGINGDIR, 'github.log') : 'github.log';
winston.info('logging debug messages to ' + filename);
winston.add(winston.transports.File, { filename: filename, level: 'debug', json: false });
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

var logger = winston;

logger.logInfo = function(username, message, object){
    if(object) {
        logger.info(username + ': ' + message, object);
    }
    else {
        logger.info(username + ': ' + message, []);
    }
}

logger.logDebug = function(username, message, object){
    if(object) {
        logger.debug(username + ': ' + message, object);
    }
    else {
        logger.debug(username + ': ' + message, []);
    }
}

logger.logError = function(username, message, object){
    if(object) {
        logger.error(username + ': ' + message, object);
    }
    else {
        logger.error(username + ': ' + message, []);
    }
}

logger.logSilly = function(username, message, object){
    if(object) {
        logger.silly(username + ': ' + message, object);
    }
    else {
        logger.silly(username + ': ' + message, []);
    }
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

var attachLogger = function, res, next){
    req.logger = winston;
    next();
};
app.use(attachLogger);

var server = app.listen(port, function () {
    logger.logInfo('', 'Listening on ' + port);
});

var qdService = new QdService();

var mongoRepository;
var githubEvents;
var githubOAuth;
mongoClient.connect(mongoUri, function (err, databaseConnection) {
    if (err) {
        logger.logError('Could not connect to Mongodb with URI: ', [mongoUri, err]);
        process.exit(1);
    } else {
        logger.logInfo('connected to mongo: ', mongoUri);
        mongoRepository = new MongoRepository(databaseConnection);
        githubEvents = new GithubEvents(mongoRepository, qdService);
        githubOAuth = new GithubOAuth(app, mongoRepository, qdService);

        githubEvents.setLogger(logger);
    }
});

app.get('/', function (req, res) {
    //req.session.integrationUri = req.headers['x-forwarded-host'];
    req.session.appUri = req.headers.referer === undefined ? '/' : req.headers.referer.split('/').slice(0,3).join('/');
    process.env.appUri = req.session.appUri;    
    req.session.oneselfUsername = req.query.username;
    req.session.registrationToken = req.query.token;
    logger.logInfo(req.query.username, 'github setup started: appUri, registrationToken', [req.session.appUri, req.query.token]);
    res.render('index');
});

app.get('/reauth', function (req, res) {
    //req.session.integrationUri = req.headers['x-forwarded-host'];
    req.session.appUri = process.env.CONTEXT_URI;
    req.session.redirect = '/reauth/complete';  
    req.session.reauth = true;
    req.session.username = req.query.username;
    logger.logInfo(req.query.username, 'reauthing', [req.session.appUri, req.query.token]);
    logger.logInfo(req.query.username, 'serving reauth page');
    res.render('reauth');
});

app.get('/reauth/complete', function (req, res) {
    //req.session.integrationUri = req.headers['x-forwarded-host'];
    req.session.appUri = null;
    req.session.redirect = null
    req.session.reauth = null;
    req.session.username = null;
    logger.logInfo(req.query.username, 'reauthing complete, ', [req.session.appUri, req.query.token]);
    logger.logDebug(req.query.username, 'serving reauth complete page');
    res.render('reauthcomplete');
});

// This is the entry point after auth, to do a sync. It's also used 
// as the callback url in the stream
app.get('/authSuccess', function (req, res) {
    var githubUsername = req.query.username;
    var streamInfo = {
        streamid: req.query.streamid,
        writeToken: req.headers.authorization,
        lastSyncDate: req.query.latestSyncField
    };
    logger.logInfo(req.query.username, 'syncing data, [stream id, write token]', [streamInfo.streamid.substring(0, 2), streamInfo.writeToken.substring(0, 2)]);    

    mongoRepository.findByGithubUsername(githubUsername)
        .then(function(user) {
            logger.logDebug(user.githubUsername, 'found in the database');
            var userInfo = {
                githubUsername: githubUsername,
                accessToken: user.accessToken,
                displayName: user.displayName,
                email: user.email
            };

            return githubEvents.sendGithubEvents(userInfo, streamInfo, process.env.appUri);
        })
        .catch(function(error){
            logger.logError(githubUsername, 'sync requested for unknown user');
        });

        res.status(200).send('ok, sync request acknowledged');
    }
);