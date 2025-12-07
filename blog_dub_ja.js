require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ==========================================
// 設定
// ==========================================
const CONFIG = {
  // コマンド名定義 (npx経由で呼び出すため)
  EXTRACT_CMD: 'extract-readability', // extract-readability, extract-chatgpt
  TRANSLATE_CMD: 'translate-to-ja',
  TTS_CMD: 'text-to-speech',

  // --- TTSモデル設定 ---
  // オプション: 'gpt-4o-mini-tts' (高速・安価), 'tts-1' (標準), 'tts-1-hd' (高品質)
  TTS_MODEL: 'gpt-4o-mini-tts', 
  
  // 音声ファイルの保存先ディレクトリ
  OUTPUT_DIR: 'outputs'
};

// ==========================================
// 外部プロセス実行関数 (汎用化)
// ==========================================

/**
 * 外部コマンドをサブプロセスとして実行する汎用関数
 * @param {string} command - 実行するコマンド (例: 'node', 'npx')
 * @param {string[]} args - コマンドに渡す引数の配列
 * @param {string} inputBody - 標準入力に流し込むテキスト (ない場合はnull/空文字)
 * @param {boolean} captureOutput - stdoutをキャプチャして返すかどうか
 */
function runCommand(command, args, inputBody, captureOutput = true) {
  return new Promise((resolve, reject) => {
    
    // ログ表示: 実行内容を分かりやすく
    const cmdStr = `${command} ${args.join(' ')}`;
    const inputLen = inputBody ? inputBody.length : 0;
    console.error(`[Main] Running: ${cmdStr} (Input: ${inputLen} chars)...`);

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

    // 標準入力への書き込み (入力がある場合のみ)
    if (inputBody && inputBody.trim().length > 0) {
      child.stdin.write(inputBody);
    }
    child.stdin.end();
  });
}

// ==========================================
// 各コマンドのラッパー関数
// ==========================================

/**
 * 記事抽出コマンドを実行するラッパー
 * Usage: npx extract_readability <URL>
 */
/**
 * 記事抽出コマンドを実行するラッパー
 * Usage: npx extract_readability <URL>
 */
async function extractWithExternalScript(url) {
  // 抽出コマンドを実行して、生の出力を取得
  const rawOutput = await runCommand('npx', [CONFIG.EXTRACT_CMD, url], null, true);
  
  try {
    // 修正: ログに含まれる `{` を回避するため、正規表現で「JSONらしい開始位置」を探す
    // 「{」の後に、改行や空白を含んで「"」が来る場所を探します
    const match = rawOutput.match(/\{\s*"/);
    const jsonStart = match ? match.index : -1;
    const jsonEnd = rawOutput.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error("Output does not contain valid JSON");
    }

    // 特定した範囲を切り出す
    const jsonStr = rawOutput.substring(jsonStart, jsonEnd + 1);

    return JSON.parse(jsonStr);

  } catch (e) {
    throw new Error(`Failed to parse extraction result: ${e.message}\nRaw Output: ${rawOutput}`);
  }
}

/**
 * 翻訳コマンドを実行するラッパー
 * Usage: echo "text" | npx translate_to_ja
 */
async function translateWithExternalScript(text) {
  if (!text) return "";
  return runCommand('npx', [CONFIG.TRANSLATE_CMD], text, true);
}

/**
 * 音声合成コマンドを実行するラッパー
 * Usage: echo "text" | npx text-to-speech -o output.mp3 --model tts-1-hd
 */
async function generateAudioWithExternalScript(text, outputPath) {
  if (!text) return;
  
  // 変更: 設定されたモデルを引数に追加 (--model)
  const args = [
    CONFIG.TTS_CMD, 
    '-o', outputPath, 
    '--model', CONFIG.TTS_MODEL
  ];

  return runCommand('npx', args, text, false);
}


// ==========================================
// ユーティリティ
// ==========================================
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 50);
}

// ==========================================
// メイン処理
// ==========================================
async function main() {
  const targetUrl = process.argv[2];
  const customOutputName = process.argv[3];

  if (!targetUrl) {
    console.error('Usage: node translate_blog.js <URL> [OUTPUT_FILENAME]');
    process.exit(1);
  }

  try {
    // 0. 準備
    if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
      fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
    }

    // 1. 記事の抽出 (CLI呼び出し)
    const articleData = await extractWithExternalScript(targetUrl);

    console.error('\n--- Extraction Success ---');
    console.error(`Title: ${articleData.title}`);
    console.error(`Domain: ${articleData.domain}`);
    console.error('--------------------------\n');

    // 2. 記事の翻訳 (CLI呼び出し)
    const translatedContent = await translateWithExternalScript(articleData.content);
    
    // 3. タイトルの翻訳 (CLI呼び出し)
    const translatedTitle = await translateWithExternalScript(`Translate this title to Japanese: ${articleData.title}`);

    // --- 結果出力 (Markdown) ---
    console.log(`# ${translatedTitle}\n`);
    console.log(`> Original URL: ${articleData.url}\n`);
    console.log(translatedContent);
    console.log('\n--- Audio Generation ---\n');

    // 4. 音声合成 (TTS)
    let audioPath;

    if (customOutputName) {
      const filename = customOutputName.endsWith('.mp3') ? customOutputName : `${customOutputName}.mp3`;
      audioPath = path.join(CONFIG.OUTPUT_DIR, filename);
    } else {
      const safeFilename = sanitizeFilename(translatedTitle || 'unknown_article');
      audioPath = path.join(CONFIG.OUTPUT_DIR, `${safeFilename}.mp3`);
    }

    console.error(`\n[Main] Starting TTS process -> ${audioPath}`);
    
    // CLI経由で音声生成を実行
    await generateAudioWithExternalScript(translatedContent, audioPath);

    console.error(`\n✅ All Done! Audio saved to: ${audioPath}`);

  } catch (error) {
    console.error('Error in main process:', error.message);
  }
}

main();