require('dotenv').config({
    path: __dirname + '/../.env'
});

const fs=require('fs');
const express=require('express');
const async = require('async');

const KBUCKET_HUB_URL=process.env.KBUCKET_HUB_URL||'https://kbucket.flatironinstitute.org';
const KBUCKET_SHARE_URL=process.env.KBUCKET_SHARE_URL||'http://localhost';
const KBUCKET_SHARE_PORTS=process.env.KBUCKET_SHARE_PORT||process.env.KBUCKET_SHARE_PORTS||4120;

var CLP=new CLParams(process.argv);

var share_directory=CLP.unnamedParameters[0]||'.';
share_directory=require('path').resolve(share_directory);
if (!fs.existsSync(share_directory)) {
  console.error('Directory does not exist: '+share_directory);
  process.exit(-1);
}
if (!fs.statSync(share_directory).isDirectory()) {
  console.error('Not a directory: '+share_directory);
  process.exit(-1);
}
var KBUCKET_SHARE_PORT=KBUCKET_SHARE_PORTS; // TODO: assign open port if this is a range

console.log (`
Using the following:
KBUCKET_HUB_URL=${KBUCKET_HUB_URL}
KBUCKET_SHARE_URL=${KBUCKET_SHARE_URL}
KBUCKET_SHARE_PORT=${KBUCKET_SHARE_PORT}

Sharing directory: ${share_directory}

`);

// ===================================================== //

const app = express();
app.set('json spaces', 4); // when we respond with json, this is how it will be formatted

// API readdir
app.get('/api/readdir/:subdirectory(*)',function(req,res) {
  var params=req.params;
  console.log(params);
  handle_readdir(params.subdirectory,req,res);
});
app.get('/api/readdir/',function(req,res) {
  var params=req.params;
  handle_readdir('',req,res);
});

// API download
app.get('/download/:filename(*)',function(req,res) {
  var params=req.params;
  handle_download(params.filename,req,res);
});

// API web
app.use('/web', express.static(__dirname+'/web'));

// ===================================================== //
  
function handle_readdir(subdirectory,req,res) {
  if (!is_safe_path(subdirectory)) {
    res.json({success:false,error:'Unsafe path: '+subdirectory});
    return;
  }
  var path0=require('path').join(share_directory,subdirectory);
  fs.readdir(path0,function(err,list) {
    if (err) {
      res.json({success:false,error:err.message});
      return;
    }
    var files=[],dirs=[];
    async.eachSeries(list,function(item,cb) {
      if ((item=='.')||(item=='..')) {
        cb();
        return;
      }
      fs.stat(require('path').join(path0,item),function(err0,stat0) {
        if (err0) {
          res.json({success:false,error:`Error in stat of file ${item}: ${err0.message}`});
          return;
        }
        if (stat0.isFile()) {
          files.push({
            name:item,
            size:stat0.size
          });
        }
        else if (stat0.isDirectory()) {
          dirs.push({
            name:item
          });
        }
        cb();
      });
    },function() {
      res.json({success:true,files:files,dirs:dirs}); 
    });
  });
}

function handle_download(filename,req,res) {
  // don't worry too much because express takes care of this below (b/c we specify a root directory)
  if (!is_safe_path(filename)) {
    res.json({success:false,error:'Unsafe path: '+filename});
    return;
  }
  var path0=require('path').join(share_directory,filename);
  if (!fs.existsSync(path0)) {
    res.json({success:false,error:'File does not exist: '+filename});
    return;
  }
  if (!fs.statSync(path0).isFile()) {
    res.json({success:false,error:'Not a file: '+filename});
    return;
  }
  res.sendFile(filename,{dotfiles:'allow',root:share_directory});
}

function is_safe_path(path) {
  var list=path.split('/');
  for (var i in list) {
    var str=list[i];
    if ((str=='~')||(str=='.')||(str=='..')) return false;
  }
  return true;
}

function start_server(callback) {
  app.listen(KBUCKET_SHARE_PORT, function() {
    console.log (`Listening on port ${KBUCKET_SHARE_PORT}`);
    console.log (`Web interface: ${KBUCKET_SHARE_URL}:${KBUCKET_SHARE_PORT}/web`)
  });
}

start_server();


function CLParams(argv) {
  this.unnamedParameters=[];
  this.namedParameters={};

  var args=argv.slice(2);
  for (var i=0; i<args.length; i++) {
    var arg0=args[i];
    if (arg0.indexOf('--')===0) {
      arg0=arg0.slice(2);
      var ind=arg0.indexOf('=');
      if (ind>=0) {
        this.namedParameters[arg0.slice(0,ind)]=arg0.slice(ind+1);
      }
      else {
        this.namedParameters[arg0]='';
        if (i+1<args.length) {
          var str=args[i+1];
          if (str.indexOf('-')!=0) {
            this.namedParameters[arg0]=str;
            i++;  
          }
        }
      }
    }
    else if (arg0.indexOf('-')===0) {
      arg0=arg0.slice(1);
      this.namedParameters[arg0]='';
    }
    else {
      this.unnamedParameters.push(arg0);
    }
  }
};
