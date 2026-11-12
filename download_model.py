from huggingface_hub import snapshot_download


MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
MODEL_DIR = "/home/bonjour/tts-model"


if __name__ == "__main__":
    path = snapshot_download(
        repo_id=MODEL_ID,
        local_dir=MODEL_DIR,
        max_workers=8,
    )
    print(f"Model ready: {path}")
