import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Audit F-1: the assistant's model runs inside the installation. The stack carries it on a network
 * with no way out; the installer sizes it to the machine, fetches it, and does not finish without it.
 */

const ROOT = path.resolve(__dirname, '../../..');
const run = promisify(execFile);
const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
/** One service's block of docker-compose.yml, to its next sibling. */
const service = (name: string) => {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|^\\S)`, 'm').exec(compose);
  expect(m, name).not.toBeNull();
  return m![1]!;
};

async function install(extra: string[], machine: { gb: number; gpu: boolean }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hivamis-'));
  try {
    const env = { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_ENV_FILE: path.join(dir, '.env'), HIVAMIS_MEMORY_GB: String(machine.gb), HIVAMIS_GPU: machine.gpu ? '1' : '0' };
    const r = await run('bash', [path.join(ROOT, 'infrastructure/hivamis'), 'install', '--org-name', 'x', '--org-slug', 'xx', '--admin-email', 'a@x.ir', '--admin-name', 'x', ...extra], { env });
    const written = readFileSync(path.join(dir, '.env'), 'utf8');
    const val = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(written)?.[1];
    return {
      out: r.stdout, err: r.stderr, profiles: val('COMPOSE_PROFILES'), chat: val('CHAT_MODE'), model: val('OLLAMA_MODEL'), ctx: val('OLLAMA_NUM_CTX'), image: val('IMAGE_MODE'), imageModel: val('IMAGE_MODEL'),
      transcription: val('TRANSCRIPTION_URL'), speechModel: val('TRANSCRIPTION_MODEL'),
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('The model inside the installation (audit F-1)', () => {
  it('runs on an internal network with no way out, keeps its models on a volume, and is what the API calls by default', () => {
    expect(compose).toMatch(/^networks:\n(?:  #.*\n)*  ai:\n    internal: true$/m);
    expect(compose).toMatch(/^x-ollama: &ollama\n  image: ollama\/ollama:\d+\.\d+\.\d+$/m);
    const shared = /^x-ollama: &ollama\n([\s\S]*?)\n\n/m.exec(compose)![1]!;
    expect(shared).toContain('- ollama-models:/root/.ollama');
    expect(shared).toMatch(/networks:\n    ai:\n      aliases: \[ollama\]/);
    // Reached by the API, and by nothing outside.
    expect(shared).not.toMatch(/^\s+ports:/m);
    for (const name of ['ollama', 'ollama-gpu']) expect(service(name)).toContain('<<: *ollama');
    expect(service('ollama')).toContain('profiles: [ai]');
    expect(service('ollama-gpu')).toMatch(/profiles: \[ai-gpu\][\s\S]*driver: nvidia[\s\S]*capabilities: \[gpu\]/);
    // Only the fetcher may reach the internet, and only when asked for.
    expect(service('ollama-pull')).toContain('profiles: [pull]');
    expect(service('ollama-pull')).not.toContain('networks:');
    expect(service('api')).toContain('OLLAMA_URL: ${OLLAMA_URL:-http://ollama:11434}');
    expect(service('api')).toContain('networks: [default, ai]');
    expect(compose).toMatch(/^volumes:\n(?:  [\w-]+:\n)*  ollama-models:$/m);
  });

  // The owner's report (2026-10-23): 14b was slow and missed its tools. 30b is a mixture of experts —
  // stronger, and faster for the 3B of it at work on each word.
  it('sizes the model to the memory it runs in: 30b on a CPU from 32 GB, 8b from 12, 4b below', async () => {
    for (const [gb, model, ctx] of [[64, 'qwen3:30b', '32768'], [32, 'qwen3:30b', '32768'], [31, 'qwen3:8b', '16384'], [12, 'qwen3:8b', '16384'], [11, 'qwen3:4b', '8192'], [6, 'qwen3:4b', '8192']] as const) {
      const r = await install([], { gb, gpu: false });
      expect([gb, r.model, r.ctx, r.profiles, r.chat]).toEqual([gb, model, ctx, 'ai', 'ollama']);
    }
  }, 60_000);

  it('on a GPU: 30b from 20 GB, 14b from 10, 8b from 6, and 32K of context for 30b', async () => {
    for (const [gb, model, ctx] of [[48, 'qwen3:30b', '32768'], [24, 'qwen3:30b', '32768'], [20, 'qwen3:30b', '32768'], [19, 'qwen3:14b', '16384'], [10, 'qwen3:14b', '8192'], [8, 'qwen3:8b', '8192'], [4, 'qwen3:4b', '8192']] as const) {
      const r = await install([], { gb, gpu: true });
      expect([gb, r.model, r.ctx, r.profiles]).toEqual([gb, model, ctx, 'ai-gpu']);
    }
  }, 60_000);

  it('chooses again for the machine as it is now, and switches to it: `model auto`', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hivamis-auto-'));
    try {
      const file = path.join(dir, '.env');
      writeFileSync(file, 'COMPOSE_PROFILES=ai,image\nCHAT_MODE=ollama\nOLLAMA_MODEL=qwen3:14b\nOLLAMA_NUM_CTX=8192\n');
      const env = { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_ENV_FILE: file, HIVAMIS_MEMORY_GB: '24', HIVAMIS_GPU: '1' };
      const r = await run('bash', [path.join(ROOT, 'infrastructure/hivamis'), 'model', 'auto'], { env });
      const at = (t: string) => { const i = r.stdout.indexOf(t); expect(i, t).toBeGreaterThan(-1); return i; };
      at('s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=ai-gpu,image|');
      at('s|^OLLAMA_MODEL=.*|OLLAMA_MODEL=qwen3:30b|');
      at('s|^OLLAMA_NUM_CTX=.*|OLLAMA_NUM_CTX=32768|');
      // The CPU's model service steps aside, the GPU's comes up, the model arrives, then the API.
      expect(at('rm -sf ollama')).toBeLessThan(at('up -d\n'));
      expect(at('ollama-pull qwen3:30b')).toBeLessThan(at('up -d api'));
      expect(r.stderr).toContain('qwen3:30b on the GPU (24 GB detected), reading 32768 tokens at once');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('runs it on the GPU when there is one, and takes a model named outright', async () => {
    const r = await install(['--model', 'qwen3:32b'], { gb: 48, gpu: true });
    expect([r.model, r.profiles]).toEqual(['qwen3:32b', 'ai-gpu']);
    expect(r.err).toContain('on the GPU');
  });

  it('fetches the model after the stack is up, shows it doing so, and checks the store before finishing', async () => {
    const r = await install([], { gb: 16, gpu: false });
    const at = (s: string) => { const i = r.out.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    expect(at('up -d --build')).toBeLessThan(at('--profile pull run --rm ollama-pull qwen3:8b'));
    expect(at('--profile pull run --rm ollama-pull qwen3:8b')).toBeLessThan(at('check that qwen3:8b is in the model store'));
    expect(at('check that qwen3:8b is in the model store')).toBeLessThan(at('tenant:create'));
    expect(r.err).toContain('fetching the assistant\'s model, qwen3:8b');
  });

  it('refuses to finish when the model did not arrive', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hivamis-'));
    try {
      // A docker that "succeeds" at everything but has no model in its store.
      const bin = path.join(dir, 'bin');
      await run('mkdir', ['-p', bin]);
      const fake = `#!/bin/sh\ncase "$*" in *"ollama list"*) printf 'NAME ID SIZE\\n' ;; *"health/ready"*) exit 0 ;; esac\nexit 0\n`;
      await run('sh', ['-c', `printf '%s' "$0" > ${bin}/docker && chmod +x ${bin}/docker`, fake]);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HIVAMIS_ENV_FILE: path.join(dir, '.env'), HIVAMIS_MEMORY_GB: '16', HIVAMIS_GPU: '0' };
      const refused = await run('bash', [path.join(ROOT, 'infrastructure/hivamis'), 'install', '--org-name', 'x', '--org-slug', 'xx', '--admin-email', 'a@x.ir', '--admin-name', 'x'], { env }).catch((e) => e);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('qwen3:8b is not in the model store');
      expect(refused.stdout ?? '').not.toContain('tenant:create');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it('leaves the model out when asked: no profile, the assistant off', async () => {
    const r = await install(['--no-ai'], { gb: 64, gpu: true });
    expect([r.profiles, r.chat]).toEqual(['', 'off']);
    expect(r.out).not.toContain('ollama-pull');
  });
});

describe('Pictures inside the installation (audit F-2)', () => {
  it('are off unless asked for', async () => {
    const r = await install([], { gb: 64, gpu: true });
    expect([r.image, r.profiles]).toEqual(['off', 'ai-gpu']);
    expect(r.out).not.toContain('imagegen-pull');
  });

  it('with --image: Stable Diffusion 1.5 on a CPU, FLUX.1-schnell on a GPU of 16 GB — fetched, and checked before finishing', async () => {
    const cpu = await install(['--image'], { gb: 32, gpu: false });
    expect([cpu.image, cpu.imageModel, cpu.profiles]).toEqual(['local', 'sd-1.5-ggml', 'ai,image']);
    expect(cpu.out).toContain('--profile pull run --rm imagegen-pull models install sd-1.5-ggml');
    expect(cpu.out.indexOf('check that sd-1.5-ggml is on the picture server')).toBeLessThan(cpu.out.indexOf('tenant:create'));
    const gpu = await install(['--image'], { gb: 24, gpu: true });
    expect([gpu.imageModel, gpu.profiles]).toEqual(['flux.1-schnell', 'ai-gpu,image-gpu']);
  });

  it('runs on the same internal network as the chat model, and is what the API calls', () => {
    expect(compose).toMatch(/^x-imagegen: &imagegen\n[\s\S]*?networks:\n    ai:\n      aliases: \[imagegen\]/m);
    expect(service('imagegen')).toMatch(/image: localai\/localai:v\d+\.\d+\.\d+\n\s+profiles: \[image\]/);
    expect(service('imagegen-pull')).toContain('profiles: [pull]');
    expect(service('api')).toContain('IMAGE_URL: ${IMAGE_URL:-http://imagegen:8080}');
    expect(service('api')).toContain('IMAGE_MODE: ${IMAGE_MODE:-off}');
  });

  // Audit F-8: what the server needs, on the systems the installer promises — Docker from Docker's
  // own repository for that release — and a plain answer anywhere else.
  it('prepares Ubuntu 22.04, Ubuntu 24.04 and Debian 12, and says what to do elsewhere', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hivamis-os-'));
    try {
      const prereqs = async (release: string) => {
        const file = path.join(dir, 'os-release');
        writeFileSync(file, release);
        return run('bash', [path.join(ROOT, 'infrastructure/hivamis'), 'prereqs'], { env: { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_OS_RELEASE: file } })
          .then((r) => ({ ok: true, out: r.stdout + r.stderr }), (e: { stdout: string; stderr: string }) => ({ ok: false, out: e.stdout + e.stderr }));
      };
      for (const [id, version, codename] of [['ubuntu', '22.04', 'jammy'], ['ubuntu', '24.04', 'noble'], ['debian', '12', 'bookworm']] as const) {
        const r = await prereqs(`ID=${id}\nVERSION_ID="${version}"\nVERSION_CODENAME=${codename}\n`);
        expect(r.ok, `${id} ${version}`).toBe(true);
        expect(r.out).toContain(`https://download.docker.com/linux/${id} ${codename} stable`);
        expect(r.out).toContain('apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin');
        expect(r.out).toContain('apt-get install -y ca-certificates curl gnupg openssl');
        expect(r.out).toContain('systemctl enable --now docker');
      }
      // An NVIDIA card: NVIDIA's container toolkit, without which Docker cannot hand it to the model.
      const gpu = await run('bash', [path.join(ROOT, 'infrastructure/hivamis'), 'prereqs'], { env: { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_GPU: '1', HIVAMIS_OS_RELEASE: path.join(dir, 'os-release') } });
      for (const step of ['apt-get install -y nvidia-container-toolkit', 'nvidia-ctk runtime configure --runtime=docker', 'systemctl restart docker']) expect(gpu.stdout).toContain(step);
      const cpu = await run('bash', [path.join(ROOT, 'infrastructure/hivamis'), 'prereqs'], { env: { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_GPU: '0', HIVAMIS_OS_RELEASE: path.join(dir, 'os-release') } });
      expect(cpu.stdout).not.toContain('nvidia');
      const other = await prereqs('ID=centos\nVERSION_ID="9"\n');
      expect(other.ok).toBe(false);
      expect(other.out).toContain('prereqs knows Ubuntu 22.04, Ubuntu 24.04 and Debian 12; this is centos 9');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is tested end to end on all three in CI, not only as a dry run', () => {
    const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/system: ubuntu-22\.04/);
    expect(ci).toMatch(/system: ubuntu-24\.04/);
    expect(ci).toMatch(/system: debian-12, runner: ubuntu-24\.04, container: 'debian:12'/);
    expect(ci).toContain('infrastructure/hivamis prereqs');
    // The administrator's activation link is a credential: the job keeps it out of its log.
    expect(ci).not.toMatch(/--no-ai \| tee/);
  });

  // Audit F-4: speech to text on the installation's own server, so a voice never leaves it.
  it('with --speech: Whisper on the speech server, fetched and answering before the install finishes', async () => {
    const plain = await install([], { gb: 32, gpu: false });
    expect([plain.transcription, plain.profiles]).toEqual(['', 'ai']);
    const r = await install(['--speech'], { gb: 32, gpu: false });
    expect([r.transcription, r.speechModel, r.profiles]).toEqual(['http://speech:8000/v1/audio/transcriptions', 'Systran/faster-whisper-medium', 'ai,speech']);
    expect(r.out).toContain('--profile pull run --rm speech-pull Systran/faster-whisper-medium');
    expect(r.out.indexOf('check that the speech server answers')).toBeLessThan(r.out.indexOf('tenant:create'));
  });

  it('keeps the speech server on the internal network, offline, with its models on a volume', () => {
    expect(service('speech')).toMatch(/image: ghcr\.io\/speaches-ai\/speaches:\d+\.\d+\.\d+-cpu\n\s+profiles: \[speech\]/);
    expect(service('speech')).toContain("HF_HUB_OFFLINE: '1'");
    expect(service('speech')).toMatch(/networks:\n      ai:\n        aliases: \[speech\]/);
    expect(service('speech')).not.toContain('ports:');
    expect(service('speech-pull')).toContain('profiles: [pull]');
    expect(service('api')).toContain('TRANSCRIPTION_URL: ${TRANSCRIPTION_URL:-}');
  });
});
