#!/usr/bin/env python3
"""
ChromaDB RAG HTTP API 服务
提供 REST API 供外部系统调用，集成 Embedding + Rerank
"""

import chromadb
from sentence_transformers import SentenceTransformer, CrossEncoder
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import uvicorn
import os
import time

# ========== 配置 ==========
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CHROMA_HOST = os.getenv("CHROMA_HOST", "127.0.0.1")
CHROMA_PORT = int(os.getenv("CHROMA_PORT", "8001"))
API_PORT = int(os.getenv("API_PORT", "8002"))
EMBEDDING_MODEL_PATH = os.getenv("EMBEDDING_MODEL_PATH", os.path.join(BASE_DIR, "models", "bge-m3"))
RERANKER_MODEL_PATH = os.getenv("RERANKER_MODEL_PATH", os.path.join(BASE_DIR, "models", "bge-reranker-v2-m3"))

# ========== 初始化模型 ==========
print("🔧 加载 Embedding 模型 (bge-m3) [CPU]...")
embedding_model = SentenceTransformer(EMBEDDING_MODEL_PATH, trust_remote_code=True, device="cpu")

print("🔧 加载 Rerank 模型 (bge-reranker-v2-m3) [CPU]...")
reranker_model = CrossEncoder(RERANKER_MODEL_PATH, trust_remote_code=True, device="cpu")

print("🔧 连接 ChromaDB...")
chroma_client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)

print("✅ 所有模型和服务已就绪！\n")

# ========== FastAPI ==========
app = FastAPI(title="ChromaDB RAG API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ========== 请求/响应模型 ==========
class AddDocumentsRequest(BaseModel):
    collection: str = "knowledge_base"
    documents: List[str]
    metadatas: Optional[List[dict]] = None
    ids: Optional[List[str]] = None


class SearchRequest(BaseModel):
    collection: str = "knowledge_base"
    query: str
    top_k: int = 10
    rerank: bool = True
    rerank_top_k: int = 5


class SearchResult(BaseModel):
    id: str
    document: str
    metadata: dict
    score: float
    rerank_score: Optional[float] = None


class SearchResponse(BaseModel):
    query: str
    results: List[SearchResult]
    total: int
    elapsed_ms: float


# ========== API 端点 ==========
@app.get("/")
def root():
    return {"service": "ChromaDB RAG API", "status": "running"}


@app.get("/health")
def health():
    try:
        chroma_client.heartbeat()
        return {"status": "ok", "chromadb": "connected"}
    except Exception as e:
        return {"status": "error", "chromadb": str(e)}


@app.get("/collections")
def list_collections():
    """列出所有集合"""
    collections = chroma_client.list_collections()
    result = []
    for c in collections:
        try:
            name = c.name if hasattr(c, "name") else str(c)
            col = chroma_client.get_collection(name)
            result.append({"name": name, "count": col.count()})
        except:
            result.append({"name": str(c), "count": -1})
    return {"collections": result}


@app.post("/collections/{name}")
def create_collection(name: str):
    """创建集合"""
    collection = chroma_client.get_or_create_collection(name=name)
    return {"name": name, "count": collection.count()}


@app.delete("/collections/{name}")
def delete_collection(name: str):
    """删除集合"""
    try:
        chroma_client.delete_collection(name=name)
        return {"message": f"集合 '{name}' 已删除"}
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/documents/add")
def add_documents(req: AddDocumentsRequest):
    """向集合添加文档"""
    collection = chroma_client.get_or_create_collection(name=req.collection)

    ids = req.ids or [f"doc_{int(time.time()*1000)}_{i}" for i in range(len(req.documents))]
    metadatas = req.metadatas or [{}] * len(req.documents)

    embeddings = embedding_model.encode(req.documents, normalize_embeddings=True).tolist()

    collection.add(
        ids=ids,
        documents=req.documents,
        metadatas=metadatas,
        embeddings=embeddings,
    )
    return {"message": f"已添加 {len(req.documents)} 条文档", "collection": req.collection, "total": collection.count()}


@app.post("/search")
def search_documents(req: SearchRequest) -> SearchResponse:
    """语义检索 + Rerank"""
    start = time.time()
    collection = chroma_client.get_or_create_collection(name=req.collection)

    if collection.count() == 0:
        return SearchResponse(query=req.query, results=[], total=0, elapsed_ms=0)

    # Step 1: Embedding 检索
    query_embedding = embedding_model.encode([req.query], normalize_embeddings=True).tolist()
    results = collection.query(
        query_embeddings=query_embedding,
        n_results=min(req.top_k, collection.count()),
        include=["documents", "metadatas", "distances"]
    )

    if not results["documents"] or not results["documents"][0]:
        return SearchResponse(query=req.query, results=[], total=0, elapsed_ms=0)

    docs = results["documents"][0]
    metas = results["metadatas"][0] if results["metadatas"] else [{}] * len(docs)
    ids = results["ids"][0] if results["ids"] else []

    candidates = []
    for id_, doc, meta, dist in zip(ids, docs, metas, results["distances"][0]):
        candidates.append({
            "id": id_,
            "document": doc,
            "metadata": meta,
            "score": round(1 - dist, 6),
            "rerank_score": None,
        })

    # Step 2: Rerank
    if req.rerank and len(candidates) > 1:
        pairs = [[req.query, c["document"]] for c in candidates]
        rerank_scores = reranker_model.predict(pairs)
        for i, score in enumerate(rerank_scores):
            candidates[i]["rerank_score"] = round(float(score), 6)
        candidates.sort(key=lambda x: x["rerank_score"], reverse=True)
        candidates = candidates[:req.rerank_top_k]

    elapsed = (time.time() - start) * 1000
    search_results = [SearchResult(**c) for c in candidates]
    return SearchResponse(query=req.query, results=search_results, total=len(search_results), elapsed_ms=round(elapsed, 1))


@app.get("/collections/{name}/count")
def get_collection_count(name: str):
    """获取集合文档数量"""
    try:
        collection = chroma_client.get_collection(name=name)
        return {"name": name, "count": collection.count()}
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


# ========== 启动 ==========
if __name__ == "__main__":
    print(f"🚀 RAG API 服务启动在 http://0.0.0.0:{API_PORT}")
    print(f"📖 API 文档: http://0.0.0.0:{API_PORT}/docs")
    print(f"🔗 ChromaDB: http://{CHROMA_HOST}:{CHROMA_PORT}")
    uvicorn.run(app, host="0.0.0.0", port=API_PORT)
