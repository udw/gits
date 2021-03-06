var fs = require('graceful-fs');
var path = require('path');
var Q = require('q');
var tmp = require('tmp');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var readJson = require('../../util/readJson');
var createError = require('../../util/createError');
var removeIgnores = require('../../util/removeIgnores');
var scripts = require('../scripts.js');

tmp.setGracefulCleanup();

function Resolver (decEndpoint, config, logger) {
    this._source = decEndpoint.source;
    this._target = decEndpoint.target || '*';
    this._name = decEndpoint.name || path.basename(this._source);

    this._config = config;
    this._logger = logger;

    this._guessedName = !decEndpoint.name;
}

// -----------------

Resolver.prototype.getSource = function () {
    return this._source;
};

Resolver.prototype.getName = function () {
    return this._name;
};

Resolver.prototype.getTarget = function () {
    return this._target;
};

Resolver.prototype.getTempDir = function () {
    return this._workingDir;
};

Resolver.prototype.getPkgMeta = function () {
    return this._pkgMeta;
};

Resolver.prototype.hasNew = function (canonicalDir, pkgMeta) {
    var promise;
    var metaFile;
    var that = this;

    // If already working, error out
    if (this._working) {
        return Q.reject(createError('Already working', 'EWORKING'));
    }

    this._working = true;

    // Avoid reading the package meta if already given
    if (pkgMeta) {
        promise = this._hasNew(canonicalDir, pkgMeta);
        // Otherwise call _hasNew with both the package meta and the canonical dir
    } else {
        metaFile = path.join(canonicalDir, '.gitsu.json');

        promise = readJson(metaFile, {
            //config: this._config,
            //name: this._guessedName ? "" : this._name
        })
                .spread(function (pkgMeta) {
                    return that._hasNew(canonicalDir, pkgMeta);
                }, function (err) {
                    that._logger.debug('read-json', 'Failed to read ' + metaFile, {
                        filename: metaFile,
                        error: err
                    });

                    return true;  // Simply resolve to true if there was an error reading the file
                });
    }

    return promise.fin(function () {
        that._working = false;
    });
};

Resolver.prototype.resolve = function () {
    var that = this;

    // If already working, error out
    if (this._working) {
        return Q.reject(createError('Already working', 'EWORKING'));
    }

    this._working = true;

    // Resolve self
    return this._resolve().then(function (res) {
        // Read json, generating the package meta
        return that._readJson(null)
                // Apply and save package meta
                .then(function (meta) {
                    return that._applyPkgMeta(meta)
                            .then(function () {
                                // it means that nothing has been resolved
                                // could happen also when the package is not cached but updated
                                if (res === null) {
                                    return that._savePkgMeta(meta, null, null, true);
                                }

                                return that._savePkgMeta(meta)
                                        // calling postresolved script
                                        .then(scripts.postresolved(that._config, that._name, that._workingDir, meta));
                            });
                });
    }).then(function () {
        // Resolve with the folder
        return that._workingDir;
    }, function (err) {
        // If something went wrong, unset the temporary dir
        that._workingDir = null;
        throw err;
    }).fin(function () {
        that._working = false;
    });
};

Resolver.prototype.isNotCacheable = function () {
    // Bypass cache for local dependencies
    if (this._source &&
            /^(?:file:[\/\\]{2}|[A-Z]:)?\.?\.?[\/\\]/.test(this._source)
            ) {
        return true;
    }

    // We don't want to cache moving targets like branches
    if (this._pkgMeta &&
            this._pkgMeta._resolution &&
            this._pkgMeta._resolution.type === 'branch')
    {
        return true;
    }

    return false;
};


// -----------------

// Abstract functions that must be implemented by concrete resolvers
Resolver.prototype._resolve = function () {
    throw new Error('_resolve not implemented');
};

// Abstract functions that can be re-implemented by concrete resolvers
// as necessary
Resolver.prototype._hasNew = function (canonicalDir, pkgMeta) {
    return Q.resolve(true);
};

Resolver.isTargetable = function () {
    return true;
};

Resolver.versions = function (source) {
    return Q.resolve([]);
};

Resolver.clearRuntimeCache = function () {
};

// -----------------

Resolver.prototype._createTempDir = function () {
    return Q.nfcall(mkdirp, this._config.tmp)
            .then(function () {
                var name = this._name.replace(/\//g, "-"); // avoid subdirectories not supported by tmp.dir
                name = name.replace(/^(%|:)/g, ""); // remove special characters not supported with some OS
                return Q.nfcall(tmp.dir, {
                    template: path.join(this._config.tmp, name + '-' + process.pid + '-XXXXXX'),
                    mode: 0777 & ~process.umask(),
                    unsafeCleanup: true
                });
            }.bind(this))
            .then(function (dir) {
                this._workingDir = dir;
                return dir;
            }.bind(this));
};

Resolver.prototype._cleanTempDir = function () {
    var tempDir = this._workingDir;

    if (!tempDir) {
        return Q.resolve();
    }

    // Delete and create folder
    return Q.nfcall(rimraf, tempDir)
            .then(function () {
                return Q.nfcall(mkdirp, tempDir, 0777 & ~process.umask());
            })
            .then(function () {
                return tempDir;
            });
};

Resolver.prototype._readJson = function (dir) {
    var that = this;

    dir = dir || this._workingDir;
    return readJson(dir, {
        assume: {name: this._name},
        config: this._config,
        name: this._guessedName ? "" : this._name
    }).spread(function (json, deprecated) {
        if (deprecated) {
            that._logger.warn('deprecated', 'Package ' + that._name + ' is using the deprecated ' + deprecated);
        }

        return json;
    });
};

Resolver.prototype._applyPkgMeta = function (meta) {
    // Check if name defined in the json is different
    // If so and if the name was "guessed", assume the json name
    if (meta.name !== this._name && this._guessedName) {
        this._name = meta.name;
    }

    // Handle ignore property, deleting all files from the temporary directory
    // If no ignores were specified, simply resolve
    if (!meta.ignore || !meta.ignore.length) {
        return Q.resolve(meta);
    }

    // Otherwise remove them from the temp dir
    return removeIgnores(this._workingDir, meta)
            .then(function () {
                return meta;
            });
};

Resolver.prototype._savePkgMeta = function (meta, dir, gitsuName, skipWrite) {
    var that = this;
    var contents;
    dir = dir || this._workingDir;

    // Store original source & target
    meta._source = this._source;
    meta._target = this._target;

    ['main', 'ignore'].forEach(function (attr) {
        if (meta[attr])
            return;

        that._logger.log(
                'warn', 'invalid-meta',
                (meta.name || 'component') + ' is missing "' + attr + '" entry in gitsu.json'
                );
    });

    if (!skipWrite) {
        // Stringify contents
        contents = JSON.stringify(meta, null, 2);

        return Q.nfcall(fs.writeFile, path.join(dir, gitsuName || '.gitsu.json'), contents)
                .then(function () {
                    return that._pkgMeta = meta;
                });
    } else {
        return that._pkgMeta = meta;
    }
};

module.exports = Resolver;
