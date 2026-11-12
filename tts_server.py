import asyncio
import io
import os
from contextlib import asynccontextmanager
from typing import Literal

import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from qwen_tts import Qwen3TTSModel


MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
MODEL_DIR = os.environ.get("QWEN_TTS_MODEL_DIR", "/home/bonjour/tts-model")
SPEAKERS = {"Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric"}
EMOTIONS = {
    "neutral": "用自然、平静的语气说",
    "sad": "用悲伤、压抑的语气说",
    "angry": "用愤怒、坚定的语气说",
    "hesitant": "用犹豫、迟疑并带有停顿的语气说",
    "whisper": "用轻柔的耳语说",
    "joy": "用开心、轻快的语气说",
}
model = None
generation_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; refusing to start CPU fallback")
    model = Qwen3TTSModel.from_pretrained(
        MODEL_DIR,
        device_map="cuda:0",
        dtype=torch.bfloat16,
        attn_implementation="sdpa",
        low_cpu_mem_usage=True,
    )
    yield
    model = None


app = FastAPI(title="Local Qwen3-TTS", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://192.168.10.10:8765",
        "https://tts.spiritwave.dpdns.org",
        "http://127.0.0.1:8765",
        "http://localhost:8765",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1200)
    speaker: Literal["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric"]
    emotion: Literal["neutral", "sad", "angry", "hesitant", "whisper", "joy"] = "neutral"
    direction: str = Field(default="", max_length=120)


@app.get("/health")
async def health():
    return {"ready": model is not None, "model": MODEL_ID, "device": "cuda:0"}


def generate_audio(request: SynthesizeRequest):
    instruction = EMOTIONS[request.emotion]
    if request.direction.strip():
        instruction = f"{instruction}，{request.direction.strip()}"
    waveforms, sample_rate = model.generate_custom_voice(
        text=request.text.strip(),
        language="Chinese",
        speaker=request.speaker,
        instruct=instruction,
    )
    buffer = io.BytesIO()
    sf.write(buffer, waveforms[0], sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="TTS model is still loading")
    async with generation_lock:
        audio = await run_in_threadpool(generate_audio, request)
    return Response(content=audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})
