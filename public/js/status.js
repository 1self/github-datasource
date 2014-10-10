var socket = io();

var getURLParameter = function (name) {
    return decodeURIComponent(
        (RegExp(name + '=' + '(.+?)(&|$)').exec(location.search) || [, null])[1]
    );
};

var githubUsername = getURLParameter("githubUsername");

$(document).ready(function () {
    socket.emit('clientConnected', githubUsername);
});

socket.on('status', function (data) {
   $('#status').html( "<div class='jumbotron center'><h3 class='header-text'>" + data.status +
        "</h3><p>Redirecting to QuantifiedDev. Enjoy the cool visualisations!</p></div>");
    setTimeout(function () {
        window.location = data.redirectUrl;
    }, 3000);
});


