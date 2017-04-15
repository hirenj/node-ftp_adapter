
var mounter = require('node-panasync/nas_mounter');
var ftpd = require('ftpd');
var fs = require('fs');
var path = require('path');
var nconf = require('nconf');
var wol = require('wake_on_lan');

// First consider commandline arguments and environment variables, respectively.
nconf.argv().env();

// Then load configuration from a designated file.
nconf.file({ file: 'config.json' });

var conf = nconf.get('nas');

var ftp_root = path.join(process.cwd(),'temp');

var temp_ftp_root = ftp_root;

var is_mounted = false;

mounter.autoMount(conf, function(mounted) {
  if (mounted) {
    nas_mounted_actions();
  } else {
    nas_unmounted_actions();
  }
});

var nas_mounted_actions = function() {
  is_mounted = true;
  console.log("Have mount point, moving path to ",conf.mount_path);
  ftp_root = path.join(process.cwd(),conf.mount_path);
  connections.forEach(function(conn,idx) {
    if ( ! conn.socket ) {
      connections.splice(connections.indexOf(conn),1);
    }
  });
  connections.forEach(function(conn) {
    conn.root = ftp_root;
  });
  copied.forEach(copy_file);
  copied.length = 0;
};

var nas_unmounted_actions = function() {
  is_mounted = false;
  console.log("Lost mount point, moving path to ",temp_ftp_root);
  ftp_root = temp_ftp_root;
  connections.forEach(function(conn,idx) {
    if ( ! conn.socket ) {
      connections.splice(connections.indexOf(conn),1);
    }
  });
  connections.forEach(function(conn) {
    conn.root = ftp_root;
  });
}

var copy_file = function(source) {
  var stat = fs.statSync(source);
  var destfile = path.join(ftp_root,path.basename(source));
  var copy_stream = fs.createReadStream(source).pipe(fs.createWriteStream(destfile));
  copy_stream.on('finish',function() {
    fs.unlinkSync(source);
    fs.utimesSync(destfile, stat.atime, stat.mtime);
    console.log("Finished copying ",source);
  });
};

var ftp_options = nconf.get('ftp');

var server = new ftpd.FtpServer(ftp_options.host, {
  getInitialCwd: function() {
    return '/';
  },
  getRoot: function() {
    return ftp_root;
  },
  pasvPortRangeStart: 1025,
  pasvPortRangeEnd: 1050,
  allowUnauthorizedTls: true,
  useWriteFile: false,
  useReadFile: false,
  uploadMaxSlurpSize: 7000, // N/A unless 'useWriteFile' is true.
});

server.on('error', function(error) {
  console.log('FTP Server error:', error);
});

var connections = [];
var copied = [];
var mounted_files = [];

server.on('client:connected', function(connection) {
  var username = null;
  console.log('client connected: ' + connection.remoteAddress);
  connections.push(connection);
  if (config.mac) {
    wol.wake(config.mac);    
  }
  // Boot up NAS here

  connection.on('command:user', function(user, success, failure) {
    if (user) {
      username = user;
      success();
    } else {
      failure();
    }
  });

  connection.on('command:pass', function(pass, success, failure) {
    if (pass) {
      success(username);
    } else {
      failure();
    }
  });

  connection.on('file:stor',function(state,file) {
    if (state === 'open' && is_mounted ) {
      console.log("Folder is mounted, writing directly");
      mounted_files.push(file.file);
    }
    if (state !== 'close') {
      return;
    }
    if ( mounted_files.indexOf(file.file) < 0) {
      console.log("We need to copy across ",file.file);
      if (is_mounted) {
        console.log("Obtained NAS mid-write, copying now");
        copy_file(path.join(temp_ftp_root,file.file));
      } else {
        console.log("Stil have no NAS - adding to queue");
        copied.push(path.join(ftp_root,file.file));
      }
    } else {
      mounted_files.splice(mounted_files.indexOf(file.file),1);
    }
  });
});

server.listen(ftp_options.port);
console.log('Listening on port ' + ftp_options.port);