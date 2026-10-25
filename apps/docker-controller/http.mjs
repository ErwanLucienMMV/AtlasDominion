import 'reflect-metadata';
import { Controller, Module, All, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { boundedHandler, hardenHttpServer } from '../../libs/http-safety.mjs';
import { Fault, authenticate, context, allowed } from './security.mjs';

export function page(items, query) {
  if (Object.keys(query).some(k => !['limit', 'cursor'].includes(k))) throw new Fault('INVALID_REQUEST');
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (query.limit !== undefined && !/^[0-9]{1,3}$/.test(query.limit))) throw new Fault('INVALID_REQUEST');
  let offset = 0;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 128 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Fault('INVALID_REQUEST');
    const decoded = Buffer.from(query.cursor, 'base64url').toString();
    if (!/^[0-9]{1,8}$/.test(decoded)) throw new Fault('INVALID_REQUEST');
    offset = Number(decoded);
  }
  return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? Buffer.from(String(offset + limit)).toString('base64url') : null };
}
function actorHeader(req) {
  const encoded = req.headers['x-atlas-authorization-context'];
  if (typeof encoded !== 'string' || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Fault('INVALID_REQUEST');
  try { return context(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))); }
  catch { throw new Fault('INVALID_REQUEST'); }
}
export async function createApplication(service, secrets, metricsSecrets = secrets) {
  if (!secrets.length || secrets.some(s => typeof s !== 'string' || Buffer.byteLength(s) < 32)) throw new Error('Strong service secrets required');
  if (!metricsSecrets.length || metricsSecrets.some(s => typeof s !== 'string' || Buffer.byteLength(s) < 32)) throw new Error('Strong metrics secrets required');
  class Api {
    async handle(req, res) {
      try {
        const path = req.path;
        authenticate(req.headers.authorization, path === '/metrics' ? metricsSecrets : secrets);
        if (path === '/metrics' && req.method === 'GET') {
          return res.type('text/plain; version=0.0.4').send(service.monitoring.render(service));
        }
        if (path === '/v1/health' && req.method === 'GET') {
          if (req.headers['x-atlas-authorization-context']) throw new Fault('INVALID_REQUEST');
          await service.reconcile();
          return res.status(service.ready ? 200 : 503).json({ ready: service.ready });
        }
        if (req.method === 'GET' && path === '/v1/servers') {
          const actor = actorHeader(req);
          if (!allowed(service.policy, actor)) throw new Fault('FORBIDDEN');
          const entries = service.instances.filter(e => allowed(e.policy, actor)).sort((a, b) => a.id.localeCompare(b.id));
          const result = page(entries, req.query);
          result.items = await Promise.all(result.items.map(e => service.status(e.id, actor)));
          return res.json(result);
        }
        const server = /^\/v1\/servers\/([a-z0-9][a-z0-9-]{0,62})(?:\/(start|stop))?$/.exec(path);
        if (server && req.method === 'GET' && !server[2]) {
          if (Object.keys(req.query).length) throw new Fault('INVALID_REQUEST');
          return res.json(await service.status(server[1], actorHeader(req)));
        }
        if (server?.[2] && req.method === 'POST') {
          if (Object.keys(req.query).length || !req.is('application/json')) throw new Fault('INVALID_REQUEST');
          const result = await service.request(server[1], server[2], req.body);
          return res.status(result.status).json(result.operation);
        }
        const operation = /^\/v1\/operations\/([a-f0-9-]{36})$/.exec(path);
        if (operation && req.method === 'GET') {
          if (Object.keys(req.query).length) throw new Fault('INVALID_REQUEST');
          return res.json(service.operation(operation[1], actorHeader(req)));
        }
        throw new Fault('INVALID_REQUEST');
      } catch (error) {
        const fault = error instanceof Fault ? error : new Fault('DOCKER_UNAVAILABLE');
        return res.status(fault.status).json({ code: fault.code, message: fault.code });
      }
    }
  }
  Api.prototype.handle = boundedHandler(Api.prototype.handle);
  Controller()(Api);
  All('{*path}')(Api.prototype, 'handle', Object.getOwnPropertyDescriptor(Api.prototype, 'handle'));
  Req()(Api.prototype, 'handle', 0); Res()(Api.prototype, 'handle', 1);
  class ApplicationModule {}
  Module({ controllers: [Api] })(ApplicationModule);
  const app = await NestFactory.create(ApplicationModule, { logger: false, bodyParser: false });
  app.use((req, res, next) => {
    try { authenticate(req.headers.authorization, req.path === '/metrics' ? metricsSecrets : secrets); next(); }
    catch { res.status(401).json({ code: 'UNAUTHENTICATED', message: 'UNAUTHENTICATED' }); }
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  app.use((error, req, res, next) => {
    if (error) res.status(400).json({ code: 'INVALID_REQUEST', message: 'INVALID_REQUEST' }); else next();
  });
  await app.init(); hardenHttpServer(app.getHttpServer()); return app;
}
