#!/usr/bin/env python3
"""将 knowledge_base.csv 的职能数据导入 ChromaDB 的 function_labels collection"""

import csv
import chromadb
from sentence_transformers import SentenceTransformer
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(BASE_DIR, "knowledge_base", "knowledge_base", "knowledge_base.csv")
EMBEDDING_MODEL_PATH = os.path.join(BASE_DIR, "models", "bge-m3")
CHROMA_HOST = "127.0.0.1"
CHROMA_PORT = 8001
COLLECTION_NAME = "function_labels"

print("🔧 加载 Embedding 模型...")
model = SentenceTransformer(EMBEDDING_MODEL_PATH, trust_remote_code=True, device="cpu")

print("🔗 连接 ChromaDB...")
client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)

# 删除旧集合（如果存在）
try:
    client.delete_collection(COLLECTION_NAME)
    print(f"🗑️  已删除旧集合 {COLLECTION_NAME}")
except:
    pass

collection = client.create_collection(name=COLLECTION_NAME)
print(f"✅ 创建集合 {COLLECTION_NAME}")

# 读取 CSV
rows = []
with open(CSV_PATH, "r", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    for row in reader:
        rows.append(row)

print(f"📖 读取 {len(rows)} 条职能数据")

# 构造文档：拼接 first_function + second_function + third_function + keywords
ids = []
documents = []
metadatas = []

for row in rows:
    fid = row.get("id", "").strip()
    industry = row.get("industry", "").strip()
    f1 = row.get("first_function", "").strip()
    f2 = row.get("second_function", "").strip()
    f3 = row.get("third_function", "").strip()
    keywords = row.get("keywords", "").strip()

    # 跳过没有职能名称的行，或只有一级职能没有二三级的空壳行
    if not f1 or (not f2 and not f3):
        continue

    # 构造搜索文档：职能路径 + 关键词
    func_path = "-".join(filter(None, [f1, f2, f3]))
    doc = f"{industry} {func_path}"
    if keywords:
        doc += f" {keywords}"

    ids.append(fid)
    documents.append(doc)
    metadatas.append({
        "industry": industry,
        "first_function": f1,
        "second_function": f2,
        "third_function": f3,
        "keywords": keywords,
        "function_path": func_path,
    })

print(f"📝 准备导入 {len(documents)} 条有效记录")

# 批量 encode + add
BATCH = 64
for i in range(0, len(documents), BATCH):
    batch_docs = documents[i:i+BATCH]
    batch_ids = ids[i:i+BATCH]
    batch_metas = metadatas[i:i+BATCH]

    embeddings = model.encode(batch_docs, normalize_embeddings=True).tolist()
    collection.add(ids=batch_ids, documents=batch_docs, metadatas=batch_metas, embeddings=embeddings)

    done = min(i + BATCH, len(documents))
    print(f"  进度: {done}/{len(documents)}")

print(f"\n✅ 导入完成！集合 {COLLECTION_NAME} 共 {collection.count()} 条记录")
