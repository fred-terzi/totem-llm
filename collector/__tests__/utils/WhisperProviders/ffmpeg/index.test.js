process.env.STORAGE_DIR = "test-storage";

const mockFfmpegPath = "/usr/bin/ffmpeg";

jest.mock("child_process", () => {
  const realFs = jest.requireActual("fs");
  return {
    execSync: jest.fn((cmd) => {
      if (cmd.includes("-version")) return "ffmpeg version 5.0\n";
      return mockFfmpegPath + "\n";
    }),
    spawnSync: jest.fn((_cmd, args, _opts) => {
      const outputPath = args?.[args.length - 1];
      if (outputPath && args?.includes("-i")) {
        try {
          realFs.writeFileSync(outputPath, Buffer.from("dummy wav data"));
        } catch (_) {}
      }
      return { status: 0, stderr: "" };
    }),
  };
});

jest.mock("fs", () => {
  const realFs = jest.requireActual("fs");
  return {
    ...realFs,
    existsSync: jest.fn((filePath) => {
      if (filePath === mockFfmpegPath) return true;
      if (filePath && filePath.includes("non-existent")) return false;
      return realFs.existsSync(filePath);
    }),
  };
});

jest.mock("../../../../utils/shell", () => ({
  patchShellEnvironmentPath: jest.fn().mockResolvedValue(process.env),
}));

const fs = require("fs");
const path = require("path");
const { FFMPEGWrapper } = require("../../../../utils/WhisperProviders/ffmpeg");

const describeRunner = process.env.GITHUB_ACTIONS ? describe.skip : describe;

describeRunner("FFMPEGWrapper", () => {
  let ffmpeg;
  const testDir = path.resolve(__dirname, "../../../../storage/tmp");
  const inputPath = path.resolve(testDir, "test-input.wav");
  const outputPath = path.resolve(testDir, "test-output.wav");

  beforeEach(() => {
    jest.clearAllMocks();
    FFMPEGWrapper._instance = null;
    ffmpeg = new FFMPEGWrapper();
  });

  afterEach(() => {
    if (fs.existsSync(inputPath)) fs.rmSync(inputPath);
    if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
  });

  it("should find ffmpeg executable", async () => {
    const knownPath = await ffmpeg.ffmpegPath();
    expect(knownPath).toBeDefined();
    expect(typeof knownPath).toBe("string");
    expect(knownPath.length).toBeGreaterThan(0);
  });

  it("should validate ffmpeg executable", async () => {
    const knownPath = await ffmpeg.ffmpegPath();
    expect(ffmpeg.isValidFFMPEG(knownPath)).toBe(true);
  });

  it("should return false for invalid ffmpeg path", () => {
    expect(ffmpeg.isValidFFMPEG("/invalid/path/to/ffmpeg")).toBe(false);
  });

  it("should convert audio file to wav format", async () => {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

    const sampleUrl =
      "https://github.com/ringcentral/ringcentral-api-docs/blob/main/resources/sample1.wav?raw=true";

    const response = await fetch(sampleUrl);
    if (!response.ok)
      throw new Error(
        `Failed to download sample file: ${response.statusText}`
      );

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(inputPath, Buffer.from(buffer));

    const result = await ffmpeg.convertAudioToWav(inputPath, outputPath);

    expect(result).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);

    const stats = fs.statSync(outputPath);
    expect(stats.size).toBeGreaterThan(0);
  }, 30000);

  it("should throw error when conversion fails", async () => {
    const nonExistentFile = path.resolve(testDir, "non-existent-file.wav");
    const outputFailPath = path.resolve(testDir, "test-output-fail.wav");

    await expect(
      ffmpeg.convertAudioToWav(nonExistentFile, outputFailPath)
    ).rejects.toThrow(`Input file ${nonExistentFile} does not exist.`);
  });
});
