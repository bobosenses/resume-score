#!/usr/bin/env python3
"""
ChromaDB RAG 服务 - 基于 bge-m3 Embedding + bge-reranker-v2-m3 Rerank
支持知识库导入和语义检索
"""

import chromadb
from sentence_transformers import SentenceTransformer, CrossEncoder
import os
import json

# ========== 配置 ==========
CHROMA_HOST = os.getenv("CHROMA_HOST", "127.0.0.1")
CHROMA_PORT = int(os.getenv("CHROMA_PORT", "8001"))
EMBEDDING_MODEL_PATH = "/root/vLLM/models/bge-m3"
RERANKER_MODEL_PATH = "/root/vLLM/models/bge-reranker-v2-m3"
COLLECTION_NAME = os.getenv("COLLECTION_NAME", "knowledge_base")

# ========== 初始化 ==========
print("🔧 加载 Embedding 模型 (bge-m3)...")
embedding_model = SentenceTransformer(EMBEDDING_MODEL_PATH, trust_remote_code=True)

print("🔧 加载 Rerank 模型 (bge-reranker-v2-m3)...")
reranker_model = CrossEncoder(RERANKER_MODEL_PATH, trust_remote_code=True)

print("🔧 连接 ChromaDB...")
chroma_client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)

print("✅ 所有模型和服务已就绪！\n")


def get_or_create_collection(name=COLLECTION_NAME):
    """获取或创建集合"""
    collection = chroma_client.get_or_create_collection(
        name=name,
        metadata={"description": "RAG 知识库"}
    )
    return collection


def add_documents(collection, documents, metadatas=None, ids=None):
    """
    向 ChromaDB 添加文档
    - documents: 文本列表
    - metadatas: 元数据列表 (可选)
    - ids: 文档ID列表 (可选, 自动生成)
    """
    if ids is None:
        ids = [f"doc_{i}" for i in range(len(documents))]
    if metadatas is None:
        metadatas = [{}] * len(documents)

    # 生成 embeddings
    embeddings = embedding_model.encode(documents, normalize_embeddings=True).tolist()

    collection.add(
        ids=ids,
        documents=documents,
        metadatas=metadatas,
        embeddings=embeddings,
    )
    print(f"✅ 已添加 {len(documents)} 条文档到集合 '{collection.name}'")


def search(collection, query, top_k=10, rerank=True, rerank_top_k=5):
    """
    语义检索 + Rerank
    - query: 查询文本
    - top_k: 初次检索返回数量
    - rerank: 是否启用重排序
    - rerank_top_k: 重排序后返回数量
    """
    # Step 1: Embedding 检索
    query_embedding = embedding_model.encode([query], normalize_embeddings=True).tolist()

    results = collection.query(
        query_embeddings=query_embedding,
        n_results=top_k,
        include=["documents", "metadatas", "distances"]
    )

    if not results["documents"] or not results["documents"][0]:
        return []

    docs = results["documents"][0]
    metas = results["metadatas"][0] if results["metadatas"] else [{}] * len(docs)
    ids = results["ids"][0] if results["ids"] else []

    candidates = [
        {"id": id_, "document": doc, "metadata": meta, "score": 1 - dist}
        for id_, doc, meta, dist in zip(ids, docs, metas, results["distances"][0])
    ]

    # Step 2: Rerank 重排序
    if rerank and len(candidates) > 1:
        pairs = [[query, c["document"]] for c in candidates]
        rerank_scores = reranker_model.predict(pairs)

        for i, score in enumerate(rerank_scores):
            candidates[i]["rerank_score"] = float(score)

        candidates.sort(key=lambda x: x["rerank_score"], reverse=True)
        candidates = candidates[:rerank_top_k]

    return candidates


# ========== 使用示例 ==========
if __name__ == "__main__":
    # 创建/获取集合
    collection = get_or_create_collection()
    print(f"📚 集合 '{collection.name}' 当前文档数: {collection.count()}\n")

    # 示例: 导入一些文档
    sample_docs = [
        "vLLM 是一个高性能的大语言模型推理引擎，支持 PagedAttention 和连续批处理。",
        "ChromaDB 是一个开源的向量数据库，用于存储和查询文本的向量表示。",
        "BGE-M3 是百度发布的多功能 Embedding 模型，支持稠密检索、稀疏检索和 ColBERT 多向量检索。",
        "Qwen3 是阿里巴巴通义千问系列的大语言模型，支持多种参数规模。",
        "RAG（检索增强生成）是一种将外部知识库与大语言模型结合的技术方案。",
        "FP8 量化可以将模型权重压缩到 8 位浮点数，大幅减少显存占用。",
        "Sentence-Transformers 库可以方便地将文本转换为固定长度的向量表示。",
        "Cross-Encoder 是一种重排序模型，对查询-文档对进行精细的相似度评分。",
    ]
    sample_metas = [
        {"source": "docs", "category": "inference"},
        {"source": "docs", "category": "database"},
        {"source": "docs", "category": "embedding"},
        {"source": "docs", "category": "llm"},
        {"source": "docs", "category": "technique"},
        {"source": "docs", "category": "quantization"},
        {"source": "docs", "category": "library"},
        {"source": "docs", "category": "rerank"},
    ]

    if collection.count() == 0:
        print("📝 导入示例文档...")
        add_documents(collection, sample_docs, sample_metas)
        print()

    # 示例: 查询
    queries = [
        "什么是向量数据库？",
        "如何减少模型显存占用？",
        "RAG 是什么技术？",
    ]

    for query in queries:
        print(f"🔍 查询: {query}")
        results = search(collection, query, top_k=5, rerank=True, rerank_top_k=3)
        for i, r in enumerate(results):
            score = r.get("rerank_score", r["score"])
            print(f"  [{i+1}] (score={score:.4f}) {r['document'][:80]}...")
        print()

    print("=" * 60)
    print("ChromaDB RAG 服务已就绪！")
    print(f"  ChromaDB:  http://{CHROMA_HOST}:{CHROMA_PORT}")
    print(f"  Embedding: {EMBEDDING_MODEL_PATH}")
    print(f"  Reranker:  {RERANKER_MODEL_PATH}")
    print(f"  集合:      {COLLECTION_NAME} ({collection.count()} 条文档)")
    print("=" * 60)
