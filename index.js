const http = require('http');
const https = require('https');

const express = require('express');
const bodyParser = require('body-parser');
const bodyParserJson = bodyParser.json();
const LRU = require('lru-cache');
const ipAddress = require('ip-address');

const SERVER_EXPIRY = 60 * 1000;
const PROXY_REQUEST_TIMEOUT = 5 * 1000;

class Prsnt {
  constructor({serverExpiry = SERVER_EXPIRY} = {}) {
    this.serversCache = new LRU({
      maxAge: serverExpiry,
    });
  }

  getServers() {
    return this.serversCache.keys()
      .map(k => this.serversCache.get(k))
      .filter(v => v !== undefined)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  requestApp() {
    const app = express();

    // const _ip6To4 = ip6 => new ipAddress.Address6(ip6).to4().address;
    // const _ip4To6 = ip4 => '::ffff:' + ip4;

    class Server {
      constructor(name, url, protocol, address, port, users, timestamp, online) {
        this.name = name;
        this.url = url;
        this.protocol = protocol;
        this.address = address;
        this.port = port;
        this.users = users;
        this.timestamp = timestamp;
        this.online = online;
      }
    }

    const cors = (req, res, next) => {
      res.set('Access-Control-Allow-Origin', req.get('Origin'));
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Allow-Credentials', true);

      next();
    };

    app.get('/prsnt/servers.json', cors, (req, res, next) => {
      res.set('Access-Control-Allow-Origin', '*');

      res.json(this.getServers());
    });
    app.post('/prsnt/announce', cors, bodyParserJson, (req, res, next) => {
      const {body: j} = req;

      const _isValidProtocol = s => /^https?$/.test(s);
      const _isValidAddress = s => /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(s);
      const _isValidVisibility = s => s === 'public' || s === 'private';

      if (
        typeof j == 'object' && j !== null &&
        typeof j.name === 'string' &&
        typeof j.protocol === 'string' && _isValidProtocol(j.protocol) &&
        typeof j.address === 'string' && _isValidAddress(j.address) &&
        typeof j.port === 'number' &&
        typeof j.visibility === 'string' && _isValidVisibility(j.visibility) &&
        Array.isArray(j.users) && j.users.every(user => typeof user === 'string')
      ) {
        const {name, protocol, address, port, users, visibility} = j;

        let server = null;
        if (visibility === 'public') {
          const url = protocol + '://' + address + ':' + port;
          const timestamp = Date.now();
          const oldOnline = (() => {
            const oldServer = this.serversCache.get(url);
            return Boolean(oldServer) && oldServer.online;
          })();
          server = new Server(name, url, protocol, address, port, users, timestamp, oldOnline);
          this.serversCache.set(url, server);
        }

        const proxyReq = (protocol === 'http' ? http : https).request({
          method: 'HEAD',
          host: address,
          port: port,
          timeout: PROXY_REQUEST_TIMEOUT,
        });
        proxyReq.on('timeout', () => {
          proxyReq.abort();
        });
        proxyReq.on('response', proxyRes => {
          proxyRes.resume();

          if (proxyRes.statusCode === 200) {
            if (server) {
              server.online = true;
            }

            res.send();
          } else {
            if (server) {
              server.online = false;
            }

            res.status(502);
            res.send();
          }
        });
        proxyReq.on('error', err => {
          if (server) {
            server.online = false;
          }

          if (err.code === 'EADDRINFO' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
            res.status(502);
            res.send();
          } else {
            res.status(500);
            res.json({
              error: err.stack,
            });
          }
        });
        proxyReq.end();
      } else {
        res.status(400);
        res.send();
      }
    });

    return Promise.resolve(app);
  }

  listen({
    hostname = null,
    port = 9999,
  } = {}) {
    this.requestApp()
      .then(app => {
        http.createServer(app)
          .listen(port, hostname, err => {
            if (!err) {
              console.log(`http://${hostname || '127.0.0.1'}:${port}`);
            } else {
              console.warn(err);
            }
          });
      })
      .catch(err => {
        console.warn(err);
      });
  }
}

module.exports = opts => new Prsnt(opts);

if (!module.parent) {
  const args = process.argv.slice(2);
  const _findArg = name => {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const match = arg.match(new RegExp('^' + name + '=(.+)$'));
      if (match) {
        return match[1];
      }
    }
    return null;
  };
  const host = _findArg('host') || '0.0.0.0';
  const port = parseInt(_findArg('port'), 10) || 8000;
  const serverExpiry = parseInt(_findArg('crdsUrl'), 10) || SERVER_EXPIRY;

  new Prsnt({
    serverExpiry,
  })
    .listen({
      host,
      port,
    });
}
