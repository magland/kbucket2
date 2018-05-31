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

const PRV_HASH = 'sha1',
    PRV_HEAD_LEN = 1000;

mkdir_if_needed(RAW_DIRECTORY);
mkdir_if_needed(UPLOADS_IN_PROGRESS_DIRECTORY);

app.use('/stat/:sha1', function(req, res) {
    if (req.method == 'OPTIONS') {
        allow_cross_domain_requests(res);
    } else if (req.method == 'GET') {
        var params = req.params;
        console.log(`stat: sha1=${params.sha1}`)

        KHM.findFile({
            sha1: params.sha1
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
                    url: resp.url,
                    alt_urls: resp.alt_urls || []
                });
            }
        });
    } else {
        res.json({
            success: false,
            error: 'Unsupported method: ' + req.method
        });
    }
});

app.use('/download/:sha1/:filename', function(req, res) {
    if (req.method == 'OPTIONS') {
        allow_cross_domain_requests(res);
    } else if (req.method == 'GET') {
        var params = req.params;
        console.log(`download: sha1=${params.sha1}`)

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
});

app.post('/upload', handle_upload);

app.use('/web', express.static(__dirname + '/web'))

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
    app.listen(PORT, function() {
        console.log(`Listening on port ${PORT}`);
    });
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
		var path=require('path').join(RAW_DIRECTORY,opts.sha1);
		if (!fs.existsSync(path)) {
			callback(`File not found: ${opts.sha1}`);
			return;
		}
		var stat=stat_file(path);
		if (!stat) {
			callback(`Unable to stat file: ${opts.sha1}`);
			return;
		}
		var url0=`${KBUCKET_HUB_URL}/download/${opts.sha1}/test`;
		callback(null,{size:stat.size,url:url0,alt_urls:[]});
	}
}

