require('dotenv').config({
    path: __dirname + '/../.env'
});

/*
Environment variables:
PORT
KBUCKET_DATA_DIRECTORY
MAX_UPLOAD_SIZE_MB
KBUCKET_HUB_URL
*/

var KHM = new KBucketHubManager();

const async = require('async');
const request = require('request');
const sanitize = require('sanitize-filename');
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');
const WebSocket = require('ws');

const express = require('express');
const app = express();
app.set('json spaces', 4); // when we respond with json, this is how it will be formatted
const PORT = process.env.PORT || 3240;
const DATA_DIRECTORY = process.env.KBUCKET_DATA_DIRECTORY;
if (!DATA_DIRECTORY) {
    console.error('KBUCKET_DATA_DIRECTORY environent variable not set. You can use a .env file.');
    return;
}
const RAW_DIRECTORY = require('path').join(DATA_DIRECTORY, 'raw');
const UPLOADS_IN_PROGRESS_DIRECTORY = require('path').join(DATA_DIRECTORY, 'uploads_in_progress');
const MAX_UPLOAD_SIZE_MB=Number(process.env.MAX_UPLOAD_SIZE_MB||1024);
const KBUCKET_HUB_URL=process.env.KBUCKET_HUB_URL||'https://kbucket.flatironinstitute.org';

console.log (`
Using the following:
PORT=${PORT}
DATA_DIRECTORY=${DATA_DIRECTORY}
MAX_UPLOAD_SIZE_MB=${MAX_UPLOAD_SIZE_MB}
KBUCKET_HUB_URL=${KBUCKET_HUB_URL}

`);

const PRV_HASH = 'sha1',
    PRV_HEAD_LEN = 1000;

mkdir_if_needed(RAW_DIRECTORY);
mkdir_if_needed(UPLOADS_IN_PROGRESS_DIRECTORY);

// API find
app.use('/find/:sha1', function(req, res) {
	var params = req.params;
	handle_find(params.sha1,'',req,res);
});
app.use('/find/:sha1/:filename(*)', function(req, res) {
	// Note: filename is just for convenience, only used in forming download urls
	var params = req.params;
	handle_find(params.sha1,params.filename,req,res);
});
// Provide stat synonym for backward-compatibility)
app.use('/stat/:sha1', function(req, res) {
	var params = req.params;
	handle_find(params.sha1,'',req,res);
});

// API download (direct from kbucket hub)
app.use('/download/:sha1', function(req, res) {
	var params = req.params;
	handle_download(params.sha1,params.sha1,req,res);
});
app.use('/download/:sha1/:filename(*)', function(req, res) {
	// Note: filename is just for convenience, not actually used
	var params = req.params;
	handle_download(params.sha1,params.filename,req,res);
});

// Forward http request to a kbucket share
app.use('/share/:share_key/:path(*)', function(req, res) {
	var params = req.params;
	handle_forward_to_share(params.share_key,req.method,params.path,req,res);
});

// API upload
app.post('/upload', handle_upload);

// API web
app.use('/web', express.static(__dirname + '/web'))

function handle_find(sha1,filename,req,res) {
    if (req.method == 'OPTIONS') {
        allow_cross_domain_requests(res);
    } else if (req.method == 'GET') {        
        console.log(`find: sha1=${sha1}`)

        KHM.findFile({
            sha1: sha1,
            filename: filename
        }, function(err, resp) {
            if (err) {
                res.json({
                    success: true,
                    found: false,
                    message: err
                });
            } else {
                res.json({
                    success: true,
                    found: true,
                    size: resp.size,
                    direct_url: resp.direct_url,
                    proxy_url: resp.proxy_url||''
                });
            }
        });
    } else {
        res.json({
            success: false,
            error: 'Unsupported method: ' + req.method
        });
    }
}

function handle_download(sha1,filename,req,res) {
    if (req.method == 'OPTIONS') {
        allow_cross_domain_requests(res);
    } else if (req.method == 'GET') {
        console.log (`download: sha1=${params.sha1}`)

        if (!is_valid_sha1(params.sha1)) {
            const errstr = `Invalid sha1 for download: ${filename}`;
            console.error(errstr);
            res.end(errstr);
            return;
        }

        var path_to_file = RAW_DIRECTORY + '/' + params.sha1;
        res.sendFile(path_to_file);
    } else {
        res.end('Unsupported method: ' + req.method);
    }
}

function handle_forward_to_share(share_key,method,path,req,res) {
	//allow_cross_domain_requests(res);
	var SS=KBSM.getShare(share_key);
	if (!SS) {
		res.json({success:false,error:`Unable to find share with key=${share_key}`});
		return;
	}
	SS.processHttpRequest(method,path,req,res);
}

function allow_cross_domain_requests(res) {
    //allow cross-domain requests
    res.set('Access-Control-Allow-Origin', '*');
    res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.set("Access-Control-Allow-Credentials", true);
    res.set("Access-Control-Max-Age", '86400'); // 24 hours
    res.set("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept, Authorization, Range");
    res.status(200).send();
    return;
}

async.series([
    start_server
]);

function start_server(callback) {
    // Start Server
    app.server=require('http').createServer(app); //todo: support https when that is being used
    app.server.listen(PORT, function() {
        console.log(`Listening on port ${PORT}`);
        start_websocket_server();
    });
}

const KBSM=new KBShareManager();

function start_websocket_server() {
	//initialize the WebSocket server instance
	const wss = new WebSocket.Server({server:app.server});

	wss.on('connection', (ws) => {
		var share_key='';
		ws.on('message', (message_str) => {
			var msg=parse_json(message_str);
			console.log('====================================== received message');
			console.log(JSON.stringify(msg,null,4));
			if (!msg) {
				console.log ('Invalid message. Closing websocket connection.');
				ws.close();
				return;
			}
			if ((share_key)&&(msg.share_key!=share_key)) {
				console.log ('Share key does not match. Closing websocket connection.');
				ws.close();
				return;
			}
			if (msg.command=='register_kbucket_share') {
				if (!is_valid_share_key(msg.share_key||'')) {
					console.log ('Invalid share key. Closing websocket connection');
					ws.close();
					return;
				}
				share_key=msg.share_key;
				if (KBSM.getShare(share_key)) {
					console.log ('A share with this key already exists. Closing websocket connection.');
					ws.close();
					return;
				}
				console.log ('Registering',JSON.stringify(msg,null,4));
				KBSM.addShare(share_key,send_message_to_share);
			}
			else {
				var SS=KBSM.getShare(share_key);
				if (!SS) {
					console.log (`Unable to find share with key=${share_key}. Closing websocket connect.`);
					ws.close();
					return;
				}
				SS.processMessageFromShare(msg,function(err,response) {
					if (err) {
						console.log (`${err}. Closing websocket connection.`);
						ws.close();
						return;
					}
					if (response) {
						send_json_message(response);
					}
				});
			}
		});

		ws.on('close',function() {
			console.log(`Websocket closed: share_key=${share_key}`);
			KBSM.removeShare(share_key);
		});

		function send_message_to_share(obj) {
			send_json_message(obj);
		}

		function send_json_message(obj) {
			console.log('------------------------------- sending message');
			console.log(JSON.stringify(obj,null,4));
			ws.send(JSON.stringify(obj));
	    }
  	});
}

function KBShareManager() {
	this.addShare=function(share_key,on_message_handler) {addShare(share_key,on_message_handler);};
	this.getShare=function(share_key) {return m_shares[share_key]||null;};
	this.removeShare=function(share_key) {removeShare(share_key);};

	var m_shares={};

	function addShare(share_key,on_message_handler) {
		if (share_key in m_shares) {
			return;
		}
		m_shares[share_key]=new KBShare(share_key,on_message_handler);
	}

	function removeShare(share_key) {
		if (!(share_key in m_shares))
			return;
		delete m_shares[share_key];
	}
}

function KBShare(share_key,on_message_handler) {
	this.processMessageFromShare=function(msg,callback) {processMessageFromShare(msg,callback);};
	this.processHttpRequest=function(method,path,req,res) {processHttpRequest(method,path,req,res);};

	var m_response_handlers={};

	function processMessageFromShare(msg) {
		if (msg.command=='http_set_response_headers') {
			if (!(msg.request_id in m_response_handlers)) {
				callback('Request id not found (in http_set_response_headers): '+msg.request_id);
				return;
			}
			m_response_handlers[msg.request_id].setResponseHeaders(msg.headers);
		}
		else if (msg.command=='http_write_response_data') {
			if (!(msg.request_id in m_response_handlers)) {
				callback('Request id not found (in http_send_response_data): '+msg.request_id);
				return;
			}
			var data=Buffer.from(msg.data_base64, 'base64');
			m_response_handlers[msg.request_id].writeResponseData(data);
		}
		else if (msg.command=='http_end_response') {
			if (!(msg.request_id in m_response_handlers)) {
				callback('Request id not found (in http_end_response): '+msg.request_id);
				return;
			}
			console.log('debug 1 calling endResponse()');
			m_response_handlers[msg.request_id].endResponse();
		}
		else if (msg.command=='http_report_error') {
			if (!(msg.request_id in m_response_handlers)) {
				callback('Request id not found (in http_report_error): '+msg.request_id);
				return;
			}
			m_response_handlers[msg.request_id].reportError(msg.error);
		}
		else {
			callback(`Unrecognized command: ${msg.command}`);
		}
	}

	function processHttpRequest(method,path,req,res) {
		console.log('processHttpRequest');
		var req_id=make_random_id(8);
		m_response_handlers[req_id]={
			setResponseHeaders:set_response_headers,
			writeResponseData:write_response_data,
			endResponse:end_response,
			reportError:report_error
		};
		send_message_to_share({
			command:'http_initiate_request',
			method:req.method,
			path:share_key+'/'+path,
			headers:req.headers,
			request_id:req_id
		});
		req.on('data',function(data) {
			send_message_to_share({
				command:'http_write_request_data',
				data_base64:data.toString('base64'),
				request_id:req_id
			});
		});
		req.on('end',function() {
			send_message_to_share({
				command:'http_end_request',
				request_id:req_id
			});
		});
		function set_response_headers(headers) {
			for (var hkey in headers) {
				console.log('setting header',hkey);
				res.set(hkey,headers[hkey]);
			}
		}
		function write_response_data(data) {
			console.log('#################### writing response data...')
			res.write(data);
		}
		function end_response() {
			console.log('++++++++++++++++++++++++++++++++++ Calling end response in end_response()');
			res.end();
		}
		function report_error(err) {
			console.error('Error in response: '+err);
			console.log('++++++++++++++++++++++++++++++++++ Calling end response in report_error()');
			res.end(); //todo: actually return the error in the proper way
		}
	}

	function send_message_to_share(msg) {
		on_message_handler(msg);
	}
}

function parse_json(str) {
	try {
		return JSON.parse(str);
	}
	catch(err) {
		return null;
	}
}

function is_valid_share_key(key) {
	return ((8<=key.length)&&(key.length<=64));
}


function is_valid_sha1(sha1) {
    if (sha1.match(/\b([a-f0-9]{40})\b/))
        return true;
    return false;
}

function handle_upload(req, res) {
    const send_response = function(obj) {
        if (res.headersSent)
            return;
        if (!obj)
            obj = {};
        obj.success = true;
        res.status(200).json(obj);
    };
    const send_error = function(err) {
        console.error('ERROR uploading' + (res.headersSent ? ' (too late)' : '') + ':', err);
        if (res.headersSent)
            return;
        res.status(400).send({
            status: 'error',
            message: err
        });
    };

    if (MAX_UPLOAD_SIZE_MB<=0) {
    	return send_error(`Uploads not allowed (MAX_UPLOAD_SIZE_MB=${MAX_UPLOAD_SIZE_MB})`);
    }

    const query = req.query;
    if (!(query.resumableIdentifier && query.resumableTotalSize >= 0)) {
        return send_error('Missing upload parameters');
    }

    const name = sanitize((query.identity ? query.identity + '-' : '') + query.resumableIdentifier);
    const size = +query.resumableTotalSize;

    if (query.max_size_bytes && size > +query.max_size_bytes)
        return send_error('File too large');

    if (size/(1024*1024)>MAX_UPLOAD_SIZE_MB) {
    	return send_error(`File too large for upload: ${size/(1024*1024)}>${MAX_UPLOAD_SIZE_MB}`);
    }

    const file = require('path').join(UPLOADS_IN_PROGRESS_DIRECTORY, name);
    const stat = stat_file(file);

    if (query.resumableDone) {
        if (!stat) {
            return send_error('Unable to stat file: ' + file);
        }
        /* resumable upload complete */
        if (stat.size != size)
            return send_error('File size mismatch: upload may be incomplete -- ' + stat.size + ' <> ' + size);
        const input = fs.createReadStream(file);
        input.pipe(crypto.createHash(PRV_HASH).setEncoding('hex'))
            .on('finish', function() {
                assert.equal(input.bytesRead, stat.size, 'File changed size while reading: ' + file);
                commit_file(file, query.resumableFileName, input.bytesRead, this.read(), (err, prv) => {
                    if (err)
                        return send_error('Error committing file: ' + err.message);
                    send_response({
                        prv: prv
                    });
                });
            });
        return;
    }

    if (query.resumableChunkSize >= 1 && query.resumableChunkNumber >= 1) {
        /* resumable chunk upload */
        console.log (`Handling upload for ${name} (chunk ${query.resumableChunkNumber})`);
        const offset = query.resumableChunkSize * (query.resumableChunkNumber - 1);
        const output = new fs.WriteStream(file, {
            flags: fs.constants.O_WRONLY | fs.constants.O_CREAT,
            start: offset
        });
        req.on('readable', () => {
            if (output.pos > size)
                send_error('File too large on upload');
        });
        req.pipe(output).on('finish', () => {
            send_response();
        });
        req.on('error', send_error);
        req.on('aborted', send_error);
    } else {
        return send_error('Missing resumable parameters');
    }
}

function mkdir_if_needed(path) {
	if (!fs.existsSync(path)) {
		fs.mkdirSync(path);
	}
}

function stat_file(path) {
    try {
        return fs.statSync(path);
    } catch (err) {
        if (err.code != 'ENOENT')
            throw err;
    }
}

function commit_file(file, name, size, hash, prv_callback) {
  const dst=require('path').join(RAW_DIRECTORY,hash);
  const next = (err) => {
    if (err)
      return prv_callback(err);
    generate_prv(dst, name, size, hash, prv_callback);
  };
  const curstat = stat_file(dst);
  if (!curstat) {
    console.info('Moving uploaded file to: '+dst);
    fs.rename(file, dst, next);
  } else {
    /* really should compare whole file but just size for now */
    assert.equal(curstat.size, size, 'MISMATCH! File already exists and is wrong size: '+dst);
    console.info('File already exists: '+dst);
    fs.unlink(file, next);
  }
}

function generate_prv(file, name, size, hash, callback) {
  fs.open(file, 'r', (err, fd) => {
    if (err)
      return callback(err);
    fs.read(fd, new Buffer(PRV_HEAD_LEN), 0, PRV_HEAD_LEN, 0, (err, len, buf) => {
      fs.close(fd);
      if (err)
        return callback(err);
      const fcs = crypto.createHash(PRV_HASH);
      fcs.update(buf.slice(0, len));
      return callback(null, {
        "prv_version": "0.11",
        "original_path": name,
        "original_size": size,
        "original_checksum": hash,
        "original_fcs": "head"+len+"-"+fcs.digest('hex')
      });
    });
  });
}

function KBucketHubManager() {
	this.findFile=function(opts,callback) {findFile(opts,callback);};

	function findFile(opts,callback) {
		if (!is_valid_sha1(opts.sha1)) {
			callback(`Invalid sha1: ${opts.sha1}`);
			return;
		}
		find_file_on_hub(opts,function(err,resp) {
			if (err) {
				callback(err);
				return;
			}
			callback(null,resp);
		});
	}

	function find_file_on_hub(opts,callback) {
		if (!KBUCKET_HUB_URL) {
			callback('KBUCKET_HUB_URL not set.');
			return;
		}
		var path_on_hub=require('path').join(RAW_DIRECTORY,opts.sha1);
		if (!fs.existsSync(path_on_hub)) {
			callback(`File not found: ${opts.sha1}`);
			return;
		}
		var stat=stat_file(path_on_hub);
		if (!stat) {
			callback(`Unable to stat file: ${opts.sha1}`);
			return;
		}
		var url0=`${KBUCKET_HUB_URL}/download/${opts.sha1}`;
		if (opts.filename) {
			url0+='/'+opts.filename;
		}
		callback(null,{
			size:stat.size,
			direct_url:url0
		});
	}
}

function make_random_id(len) {
    var text = "";
    var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    for( var i=0; i < len; i++ )
        text += possible.charAt(Math.floor(Math.random() * possible.length));

    return text;
}