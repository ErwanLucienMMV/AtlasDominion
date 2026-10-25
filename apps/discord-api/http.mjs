import 'reflect-metadata';
import { Controller, Module, Post, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { boundedHandler, hardenHttpServer } from '../../libs/http-safety.mjs';
import { publicKey, signed, actor, allowed, RateLimit, validateConfig } from './security.mjs';
import { command } from './service.mjs';
import { message } from './commands.mjs';

export async function createDiscordApplication(service, configuration) {
  const config = validateConfig(configuration), key = publicKey(config.publicKey), limiter = new RateLimit();
  class Interactions {
    async handle(req, res) {
      if (!Buffer.isBuffer(req.body) || !signed(key, req.body, req.headers)) return res.status(401).json({ code: 'UNAUTHENTICATED' });
      let interaction;
      try { interaction = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ code: 'INVALID_REQUEST' }); }
      if (interaction?.type === 1) return res.json({ type: 1 });
      const autocomplete = interaction?.type === 4;
      const reply = content => res.json(autocomplete ? { type: 8, data: { choices: [] } } : { type: 4, data: { ...message(content), flags: 64 } });
      if (![2, 4].includes(interaction?.type) || interaction.application_id !== config.applicationId ||
        typeof interaction.id !== 'string' || !/^[0-9]{17,20}$/.test(interaction.id) || typeof interaction.token !== 'string' || !/^[A-Za-z0-9._-]{1,2048}$/.test(interaction.token)) return res.status(400).json({ code: 'INVALID_REQUEST' });
      let identity, selection;
      try { identity = actor(interaction); } catch { return reply('Guild member authorization is required.'); }
      if (!allowed(config.policy, identity)) return reply('You are not authorized to manage servers.');
      if (!limiter.take(identity)) return reply('Request limit reached. Try again later.');
      try { selection = command(interaction.data, autocomplete); } catch { return reply('Invalid server command or instance identifier.'); }
      if (autocomplete) {
        try { return res.json({ type: 8, data: { choices: await service.autocomplete(selection, identity) } }); }
        catch { return res.json({ type: 8, data: { choices: [] } }); }
      }
      const reservation = service.reserve(interaction);
      if (reservation === 'busy') return reply('Request capacity reached. Try again later.');
      // Send acknowledgement before any controller work; duplicates do no new work.
      res.json({ type: 5, data: { flags: 64 } });
      if (reservation === 'accepted') setImmediate(() => { void service.complete(interaction, selection, identity); });
    }
  }
  Interactions.prototype.handle = boundedHandler(Interactions.prototype.handle);
  Controller()(Interactions);
  Post('discord/interactions')(Interactions.prototype, 'handle', Object.getOwnPropertyDescriptor(Interactions.prototype, 'handle'));
  Req()(Interactions.prototype, 'handle', 0); Res()(Interactions.prototype, 'handle', 1);
  class ApplicationModule {}
  Module({ controllers: [Interactions] })(ApplicationModule);
  const app = await NestFactory.create(ApplicationModule, { logger: false, bodyParser: false });
  app.use(express.raw({ type: 'application/json', limit: '64kb', inflate: false }));
  app.use((error, req, res, next) => { if (error) res.status(400).json({ code: 'INVALID_REQUEST' }); else next(); });
  await app.init(); hardenHttpServer(app.getHttpServer()); return app;
}
