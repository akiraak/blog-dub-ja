require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ==========================================
// 設定
// ==========================================
const CONFIG = {
  EXTRACT_CMD: 'extract-readability',
  TRANSLATE_CMD: 'translate-to-ja',
  TTS_CMD: 'text-to-speech',
  TTS_MODEL: 'gpt-4o-mini-tts',
  OUTPUT_DIR: 'outputs'
};

// ==========================================
// 1. コマンド実行管理クラス
// ==========================================
class CommandRunner {
  async run(command, args, inputBody = null, captureOutput = true) {
    return new Promise((resolve, reject) => {
      const cmdStr = `${command} ${args.join(' ')}`;
      const inputLen = inputBody ? inputBody.length : 0;
      console.error(`[Exec] Running: ${cmdStr} (Input: ${inputLen} chars)...`);

      const child = spawn(command, args, {
        stdio: ['pipe', captureOutput ? 'pipe' : 'inherit', 'inherit']
      });

      let outputData = '';

      if (captureOutput) {
        child.stdout.on('data', (chunk) => {
          outputData += chunk.toString();
        });
      }

      child.on('error', (err) => {
        reject(new Error(`Failed to start process: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Process exited with code ${code}`));
        } else {
          resolve(captureOutput ? outputData.trim() : true);
        }
      });

      if (inputBody && inputBody.trim().length > 0) {
        child.stdin.write(inputBody);
      }
      child.stdin.end();
    });
  }
}

// ==========================================
// 2. ディレクトリ・パス管理クラス
// ==========================================
class DirectoryManager {
  constructor(baseOutputDir) {
    this.baseOutputDir = baseOutputDir;
    this.projectDir = null;
    this.debugRoot = null;
    this.dirs = {}; 
    this.timestamp = ''; 
  }

  initializeProject(projectName) {
    const cleanName = this._sanitizeFilename(projectName);
    this.projectDir = path.join(this.baseOutputDir, cleanName);

    if (!fs.existsSync(this.baseOutputDir)) {
      fs.mkdirSync(this.baseOutputDir);
    }

    // ★ 変更点: 既存ディレクトリの削除処理 (fs.rmSync) を削除しました

    // ディレクトリが存在してもエラーにならないよう { recursive: true } を付与
    fs.mkdirSync(this.projectDir, { recursive: true });
    
    // タイムスタンプを固定
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    this.timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    console.error(`[Dir] Project Directory ready: ${this.projectDir} (Timestamp: ${this.timestamp})`);
    return this.projectDir;
  }

  setupDebugDirectories(isDebug) {
    if (!isDebug) return;

    this.debugRoot = path.join(this.projectDir, `debug_${this.timestamp}`);
    fs.mkdirSync(this.debugRoot, { recursive: true });

    this.dirs = {
      extract: path.join(this.debugRoot, 'extract-readability'),
      translateTitle: path.join(this.debugRoot, 'translate-to-ja-title'),
      translateContent: path.join(this.debugRoot, 'translate-to-ja-content'),
      tts: path.join(this.debugRoot, 'text-to-speech')
    };
  }

  getDebugPath(key) {
    return this.dirs[key] || null;
  }

  generateOutputFilename(projectName, extension) {
    return path.join(this.projectDir, `${this._sanitizeFilename(projectName)}_${this.timestamp}.${extension}`);
  }

  _sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, '_').slice(0, 50);
  }
}

// ==========================================
// 3. メインロジック (Facade)
// ==========================================
class BlogDubber {
  constructor() {
    this.runner = new CommandRunner();
    this.dirManager = new DirectoryManager(CONFIG.OUTPUT_DIR);
  }

  async extract(url, debugPath) {
    const args = [CONFIG.EXTRACT_CMD, url];
    if (debugPath) args.push('--debug-dir', debugPath);

    const rawOutput = await this.runner.run('npx', args, null, true);
    try {
      const match = rawOutput.match(/\{\s*"/);
      const jsonStart = match ? match.index : -1;
      const jsonEnd = rawOutput.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd === -1) throw new Error("JSON not found in output");
      
      return JSON.parse(rawOutput.substring(jsonStart, jsonEnd + 1));
    } catch (e) {
      throw new Error(`Extraction failed: ${e.message}`);
    }
  }

  async translate(text, debugPath) {
    if (!text) return "";
    const args = [CONFIG.TRANSLATE_CMD];
    if (debugPath) args.push('--debug-dir', debugPath);
    
    // コマンド実行
    let output = await this.runner.run('npx', args, text, true);

    // [dotenv@...] から始まる行を削除する
    output = output.replace(/^\[dotenv@.+/gm, '').trim();

    return output;
  }

  async generateAudio(text, outputPath, debugPath) {
    if (!text) return;
    const args = [CONFIG.TTS_CMD, '-o', outputPath, '--model', CONFIG.TTS_MODEL];
    if (debugPath) args.push('--debug-dir', debugPath);
    return this.runner.run('npx', args, text, false);
  }

  async execute() {
    const args = process.argv.slice(2);
    const debugIndex = args.findIndex(arg => arg === '--debug' || arg === '-d');
    const isDebug = debugIndex !== -1;
    if (isDebug) args.splice(debugIndex, 1);

    const targetUrl = args[0];
    const customName = args[1];

    if (!targetUrl) {
      console.error('Usage: node blog_dub_ja.js <URL> [OUTPUT_NAME] [--debug]');
      process.exit(1);
    }

    let projectName = customName;
    if (!projectName) {
      try {
        const urlObj = new URL(targetUrl);
        const timestamp = Date.now().toString().slice(-6);
        projectName = `${urlObj.hostname.replace(/\./g, '_')}_${timestamp}`;
      } catch {
        projectName = `job_${Date.now()}`;
      }
    }

    try {
      this.dirManager.initializeProject(projectName);
      this.dirManager.setupDebugDirectories(isDebug);

      // --- 1. 記事抽出 ---
      console.error('\n[Phase 1] Extracting Article...');
      const article = await this.extract(targetUrl, this.dirManager.getDebugPath('extract'));
      console.error(`Title: ${article.title}`);

      // --- 2. タイトル翻訳 ---
      console.error('\n[Phase 2] Translating Title...');
      const titleJa = await this.translate(
        `Translate this title to Japanese: ${article.title}`, 
        this.dirManager.getDebugPath('translateTitle')
      );

      // --- 3. 本文翻訳 ---
      console.error('\n[Phase 3] Translating Content...');
      const contentJa = await this.translate(article.content, this.dirManager.getDebugPath('translateContent'));

      // --- テキスト保存処理 ---
      const textPath = this.dirManager.generateOutputFilename(projectName, 'txt');
      const textData = `Title: ${titleJa}\n\n${contentJa}`;
      fs.writeFileSync(textPath, textData);
      console.error(`\n[Save] Text saved: ${textPath}`);

      // --- 4. 音声合成 ---
      console.error('\n[Phase 4] Generating Audio...');
      const audioPath = this.dirManager.generateOutputFilename(projectName, 'mp3');
      await this.generateAudio(contentJa, audioPath, this.dirManager.getDebugPath('tts'));

      // --- 完了報告 ---
      console.error(`\n✅ All Done!`);
      console.error(`   Text:  ${textPath}`);
      console.error(`   Audio: ${audioPath}`);
      if (isDebug) {
        console.error(`   Debug Info saved in: ${this.dirManager.debugRoot}`);
      }

    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  }
}

if (require.main === module) {
  new BlogDubber().execute();
}