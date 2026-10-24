import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const stagingCA = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const productionCA = 'https://acme-v02.api.letsencrypt.org/directory';

// Pure rendering is separately testable; no Docker commands or network calls.
export function renderInfrastructure(config) {
  const keys = ['hostname', 'acmeEmail', 'acmeChallenge', 'certificateAuthority', 'traefikImage', 'accessLogs'];
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(config, key))) {
    throw new Error('Invalid infrastructure configuration fields');
  }
  const { hostname, acmeEmail, acmeChallenge, certificateAuthority, traefikImage, accessLogs } = config;
  if (typeof hostname !== 'string' || hostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) ||
      hostname.endsWith('.invalid') || hostname.endsWith('.localhost')) throw new Error('Invalid public hostname');
  if (typeof acmeEmail !== 'string' || !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/.test(acmeEmail) || acmeEmail.length > 254) throw new Error('Invalid ACME email');
  if (!['http-01', 'tls-alpn-01'].includes(acmeChallenge)) throw new Error('Unsupported ACME challenge');
  if (!['staging', 'production'].includes(certificateAuthority)) throw new Error('Explicit ACME authority required');
  if (typeof traefikImage !== 'string' || !/^traefik:v3\.\d+\.\d+(?:@sha256:[a-f0-9]{64})?$/.test(traefikImage)) throw new Error('Version-pinned Traefik v3 image required');
  if (!['disabled', 'sanitized'].includes(accessLogs)) throw new Error('Explicit access log policy required');

  const acme = {
    email: acmeEmail, storage: '/state/acme.json',
    caServer: certificateAuthority === 'staging' ? stagingCA : productionCA,
    ...(acmeChallenge === 'http-01' ? { httpChallenge: { entryPoint: 'web' } } : { tlsChallenge: {} })
  };
  const staticConfig = {
    global: { checkNewVersion: false, sendAnonymousUsage: false },
    entryPoints: {
      web: { address: ':80', http: { redirections: { entryPoint: { to: 'websecure', scheme: 'https', permanent: true } } } },
      websecure: { address: ':443' }
    },
    providers: { file: { directory: '/etc/traefik/dynamic', watch: true } },
    certificatesResolvers: { letsencrypt: { acme } },
    log: { level: 'ERROR', format: 'json' }
  };
  if (accessLogs === 'sanitized') staticConfig.accessLog = {
    format: 'json', filePath: '/logs/access.json',
    fields: { defaultMode: 'drop', names: { StartUTC: 'keep', Duration: 'keep', DownstreamStatus: 'keep', RouterName: 'keep' }, headers: { defaultMode: 'drop' } }
  };
  const dynamicConfig = {
    http: {
      routers: {
        'discord-interactions': {
          rule: `Host(\`${hostname}\`) && Path(\`/discord/interactions\`) && Method(\`POST\`)`,
          entryPoints: ['websecure'], service: 'discord-api',
          middlewares: ['strip-internal-context', 'bounded-body'],
          tls: { certResolver: 'letsencrypt', options: 'default' }
        }
      },
      services: { 'discord-api': { loadBalancer: { servers: [{ url: 'http://atlas-discord-api:3000' }] } } },
      middlewares: {
        'strip-internal-context': { headers: { customRequestHeaders: { 'X-Atlas-Authorization-Context': '' } } },
        'bounded-body': { buffering: { maxRequestBodyBytes: 16384, memRequestBodyBytes: 16384 } }
      }
    },
    tls: { options: { default: { minVersion: 'VersionTLS12' } } }
  };
  const compose = {
    name: 'atlas-edge',
    services: {
      traefik: {
        image: traefikImage, pull_policy: 'never', restart: 'unless-stopped',
        command: ['--configFile=/etc/traefik/traefik.yml'],
        read_only: true, cap_drop: ['ALL'], cap_add: ['NET_BIND_SERVICE'],
        security_opt: ['no-new-privileges:true'],
        ports: ['80:80/tcp', '443:443/tcp'],
        networks: ['proxy', 'egress'],
        volumes: [
          { type: 'bind', source: './traefik.yml', target: '/etc/traefik/traefik.yml', read_only: true, bind: { create_host_path: false } },
          { type: 'bind', source: './dynamic', target: '/etc/traefik/dynamic', read_only: true, bind: { create_host_path: false } },
          { type: 'bind', source: './state', target: '/state', bind: { create_host_path: false } },
          ...(accessLogs === 'sanitized' ? [{ type: 'bind', source: './logs', target: '/logs', bind: { create_host_path: false } }] : [])
        ],
        logging: { driver: 'local', options: { 'max-size': '1m', 'max-file': '2' } }
      }
    },
    networks: { proxy: { external: true, name: 'atlas-proxy' }, egress: { name: 'atlas-edge-egress' } }
  };
  return { compose, staticConfig, dynamicConfig };
}

export async function writeInfrastructure(config, outputDirectory) {
  const rendered = renderInfrastructure(config);
  // Exclusive directory creation: never replace prior files, symlinks or ACME state.
  await mkdir(outputDirectory, { mode: 0o700 });
  for (const directory of ['dynamic', 'state', ...(config.accessLogs === 'sanitized' ? ['logs'] : [])]) {
    await mkdir(join(outputDirectory, directory), { mode: 0o700 });
  }
  for (const [file, value] of [
    ['compose.json', rendered.compose], ['traefik.yml', rendered.staticConfig], ['dynamic/routes.yml', rendered.dynamicConfig]
  ]) await writeFile(join(outputDirectory, file), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(join(outputDirectory, 'state/acme.json'), '', { flag: 'wx', mode: 0o600 });
  return rendered;
}
