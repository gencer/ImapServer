
var EventEmitter = require('events').EventEmitter;
var tls = require('tls');

var States = require('./states.js');
var PluginIterator = require('./pluginIterator.js');
var parse = require('./parser.js');
var util = require('./util.js');

var TIMEOUT = 30 * 1000;

function ImapConnection(server, stream) {
    EventEmitter.call(this);
    this.server = server;
    this.stream = null;
    this.state = States.NotAuthenticated;
    this.onTimeout = this.onTimeout.bind(this);
    this.timeout = setTimeout(this.onTimeout, TIMEOUT);

    this.notes = {
        remoteAddress: stream.remoteAddress,
        remotePort: stream.remotePort
    };

    this.paused = false;
    this.lineBuffer = [];
    this.continueCb = null;
    this.setStream(stream);
    this.stream.on('data', this.onData.bind(this));
    this.stream.on('close', this.onDisconnect.bind(this));

    this.callPLugins('connection', [this], true);
}
module.exports = ImapConnection;
ImapConnection.prototype = Object.create(EventEmitter.prototype);

/*
 *  Plugins support
 */
ImapConnection.prototype.getCapabilities = function() {
    return this.server.getCapabilities(this);
};

ImapConnection.prototype.callPLugins = function(hook, params, all, cb) {
    var connection = this;
    connection.pause();
    if(typeof all == 'function') {
        cb = all;
        all = false;
    }
    var iter = PluginIterator.call(this.server, this.server.plugins.slice(0),
        hook, params, all || false, function(err) {
            if(typeof cb == 'function') {
                cb.apply(null, arguments);
            }
            else if(err) {
                console.error('Uncaught plugin error:', err, '\r\n', err.stack);
            }
            process.nextTick(connection.resume.bind(connection));
        });
    process.nextTick(iter);
};


/*
 *  Data receiving
 */
ImapConnection.prototype.continueReq = function(data, cb) {
    var line = '+ ';
    if(typeof data != 'function') {
        line += data.toString();
    }
    else {
        cb = data;
    }
    this.continueCb = cb;
    this.write(line + '\r\n');
    console.log('[%s:%d] <<< %s', this.notes.remoteAddress, this.notes.remotePort, line);
};

ImapConnection.prototype.pause = function() {
    this.paused = true;
};

ImapConnection.prototype.resume = function() {
    this.paused = false;
    this.onData();
};

ImapConnection.prototype.onData = function(data) {
    // timeout reset
    clearTimeout(this.timeout);
    this.timeout = setTimeout(this.onTimeout, TIMEOUT);

    // parse lines
    var lines;
    if(data) {
        lines = data.toString('ascii').split('\r\n');
        lines[0] = (this.lineBuffer.pop() || '') + lines[0];
        this.lineBuffer = this.lineBuffer.concat(lines);
    }
    lines = this.lineBuffer;
    while(lines.length > 1 && !this.paused) {
        var line = lines.shift();
        if(line[0] == '+') {
            if(typeof this.continueCb == 'function') {
                var cb = this.continueCb;
                this.continueCb = null;
                cb.call(this.server, line.slice(2));
            }
            else {
                this.send(null, 'BYE', "Not allow to send this data");
            }
        }
        else {
            line = parse(line);
            if(line.literals === false) {
                this.onLine(line);
            }
            else {
                console.log(typeof line.literals, line.literals, line);
                throw new Error('Literals continue request not implemented');
            }
        }
    }
};

ImapConnection.prototype.onLine = function(line) {
    switch(line.command) {
        case 'CAPABILITY' :
            var caps = this.server.getCapabilities(this);
            this.send(null, 'CAPABILITY', caps.join(' '));
            this.send(line.tag, 'OK', 'CAPABILITY completed');
            return;
        case 'NOOP':
            this.send(line.tag, 'OK', 'NOOP completed');
            return;
        case 'LOGOUT':
            this.send(null, 'BYE', 'See you soon!');
            this.send(line.tag, 'OK', 'LOGOUT completed');
            this.close();
            return;
    }
    if(this.state == States.NotAuthenticated) {
        switch(line.command) {
            case 'STARTTLS':
                this.callPLugins('starttls', [this]);
                return;
            case 'LOGIN':
                if(line.args.length < 2) {
                    this.send(line.tag, 'BAD', 'Need a username and password to login');
                    return;
                }
                util.loginToAuthPlain(line);
            case 'AUTHENTICATE':
                if(!line.args.length) {
                    this.send(line.tag, 'BAD', 'Need an authentication mechanism to proceed.');
                    return;
                }
                var auth = 'auth_'+line.args[0].toLowerCase();
                this.callPLugins(auth, [this, line], afterAuthenticate.bind(this, line.tag));
                return;
            default:
                this.callPLugins('unknown_command', [this, line], afterCommand.bind(this, line.tag));
                return;
        }
    }
    if(this.state == States.Authenticated) {
        switch(line.command) {
            case 'EXAMINE':
            case 'CREATE':
            case 'DELETE':
            case 'RENAME':
            case 'SUBSCRIBE':
            case 'UNSUBSCRIBE':
            case 'STATUS':
            case 'APPEND':
            case 'LSUB':
                console.log('Received command:', line.command, line.args);
                this.send(line.tag, 'BAD', 'Command not implemented');
                return;
            case 'LIST':
                if(line.args.length != 2) {
                    this.send(line.tag, 'BAD', 'LIST needs 2 arguments');
                }
                else {
                    this.callPLugins('list', [this, line.args[0], line.args[1]], afterCommand.bind(this, line.tag));
                }
                return;
            case 'SELECT':
                if(line.args.length != 1) {
                    this.send(line.tag, 'BAD', 'SELECT needs a mailbox name');
                }
                else {
                    this.callPLugins('select', [this, line.args[0]], afterSelect.bind(this, line.tag));
                }
                return;
            default:
                this.callPLugins('unknown_command', [this, line]);
                return;
        }
    }
};

function afterCommand(code, err, res, msg) {
    if(err) {
        this.send(code, 'BAD',  msg || 'Error processing your request.');
        console.error('An error happen:', err, '\r\n', err.stack);
    }
    else if(res == 'OK') {
        this.send(code, 'OK', msg || 'completed.');
    }
    else if(res == 'NO') {
        this.send(code, 'NO', msg || 'action refused.');
    }
    else if(res == 'BAD') {
        this.send(code, 'BAD', msg || 'Client error.');
    }
    else {
        this.send(code, 'BAD', 'Something strange happen.');
        console.error('Plugin send invalid response:', res, msg);
    }
}

function afterAuthenticate(code, err, res, msg) {
    if(res == 'OK') {
        this.state = States.Authenticated;
        this.send(code, 'OK', msg || '[CAPABILITY '+this.getCapabilities().join(' ')+'] Logged in');
    }
    else if(res == 'NO') {
        this.send(code, 'NO', msg || 'Bad username or password.');
    }
    else {
        afterCommand.apply(this, arguments);
    }
}

function afterSelect(code, err, res, msg) {
    if(res == 'OK') {
        this.state = States.Selected;
        this.send(code, 'OK', msg || 'Select completed');
    }
    else if(res == 'NO') {
        this.send(code, 'NO', msg || 'Select failled');
    }
    else {
        afterCommand.apply(this, arguments);
    }
}


/*
 *  Connection state
 */
ImapConnection.prototype.onDisconnect = function() {
    console.log('Client Disconnected');
};

ImapConnection.prototype.onTimeout = function() {
    this.send(null, 'BYE', 'Disconnected for inactivity.');
    this.stream.destroySoon();
};

ImapConnection.prototype.close = function() {
    // TODO
};

ImapConnection.prototype.send = function(id, cmd, info) {
    var msg = (id?id:'*')+' '+cmd.toUpperCase()+' '+info;
    this.stream.write(msg+'\r\n');
    var s = this.stream;
    console.log('[%s:%d] <<< %s', this.notes.remoteAddress, this.notes.remotePort, msg);
};

ImapConnection.prototype.setStream = function(stream) {
    if(this.stream) {
        for(var event in this.stream._events) {
            var listeners = this.stream.listeners(event);
            stream._events[event] = listeners.slice(0);
        }
    }
    this.stream = stream;
};

ImapConnection.prototype.write = function() {
    return this.stream.write.apply(this.stream, arguments);
};

Object.defineProperty(ImapConnection.prototype, 'secure', {
    // TODO : this crash
    get: function() {
        return (this.stream instanceof tls.CleartextStream);
    }
});