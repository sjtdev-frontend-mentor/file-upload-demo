<!-- App.vue -->
<template>
  <main>
    <input :key="fileInputKey" class="hidden" type="file" name="" id="" :multiple="allowMultiple" ref="fileInput" @change="handleFileChange" />

    <div class="grid w-200 grid-cols-[1fr_100px_150px_auto] items-center">
      <div v-for="(fileInfo, index) in files" :key="fileInfo.id" class="contents">
        <div>{{ fileInfo.file.name }}</div>
        <div>{{ formatSize(fileInfo.file.size) }}</div>
        <div>
          {{ UploadStatus[fileInfo.status] }}
          <span v-if="fileInfo.status === 'uploading' || fileInfo.status === 'processing'">({{ fileInfo.progress }}%)</span>
        </div>
        <button :disabled="isUploading" @click="files = files.filter((f) => f.id !== fileInfo.id)">移除</button>
      </div>
    </div>
    <button :disabled="isUploading" @click="fileInput?.click()">选择文件</button>
    <button :disabled="isUploading || !hasFiles" @click="uploadFiles()">开始上传</button>
    <button :disabled="isUploading || !hasFiles" @click="clearFiles()">清空列表</button>
  </main>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import axios from "axios";

enum UploadStatus {
  ready = "准备就绪",
  uploading = "上传中",
  processing = "处理中",
  completed = "上传完成",
  error = "上传错误",
}

interface FileInfo {
  id: string; // 唯一标识
  file: File; // 原始文件对象
  status: "ready" | "uploading" | "processing" | "completed" | "error"; // 上传状态
  progress: number; // 上传进度 0-100
  error?: string; // 错误信息
}

const allowMultiple = ref(true);
const fileInput = ref<HTMLInputElement>();
const fileInputKey = ref(0);
const files = ref<FileInfo[]>([]);
const isUploading = computed(() => files.value.some((f) => f.status === "uploading" || f.status === "processing"));
const hasFiles = computed(() => files?.value?.length > 0);

const CHUNK_SIZE = 1024 * 1024 * 1; // 5MB
const MAX_REQUESTS = 4;

function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files?.length) return;

  const newFiles = Array.from(input.files).map((file) => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    file,
    status: "ready" as const,
    progress: 0,
  }));

  if (allowMultiple.value) {
    files.value = [...files.value, ...newFiles];
  } else {
    files.value = [newFiles[0]]; // 单文件模式只保留最新文件
  }
}

type ChunkMetadata = {
  index: number;
  startByte: number;
  endByte: number;
  chunkSize: number;
  status: "ready" | "uploading" | "pending" | "done" | "error";
  fileInfo: FileInfo;
};

async function uploadFiles() {
  // 过滤出可上传的文件
  const filesToUpload = files.value.filter((f) => f.status === "ready");

  // 检查是否有文件需要上传
  if (!filesToUpload.length) return;

  const allChunkMetadata: ChunkMetadata[] = [];
  for (const fileInfo of filesToUpload) {
    try {
      let offset = 0;
      while (offset < fileInfo.file.size) {
        const start = offset;
        const end = Math.min(fileInfo.file.size, offset + CHUNK_SIZE);
        const index = allChunkMetadata.length;
        allChunkMetadata.push({
          index,
          startByte: start,
          endByte: end - 1,
          chunkSize: end - start,
          status: "pending",
          fileInfo,
        });
        offset = end;
      }
    } catch (error) {}
  }
  uploadChunks(allChunkMetadata);
}

function uploadChunks(chunks: ChunkMetadata[]) {
  // 1. 统计每个文件的总分块数
  const totalChunksMap = new Map<string, number>();
  // 2. 创建已上传分块计数器
  const uploadedChunksMap = new Map<string, number>();

  for (const chunk of chunks) {
    const fileId = chunk.fileInfo.id;
    totalChunksMap.set(fileId, (totalChunksMap.get(fileId) || 0) + 1);
    uploadedChunksMap.set(fileId, 0); // 初始化为0
  }

  // 3. 并发控制参数
  const CONCURRENCY_LIMIT = 4;
  let activeRequests = 0;
  let currentIndex = 0;

  // 4. 实际请求函数
  async function _request() {
    if (currentIndex >= chunks.length || activeRequests >= CONCURRENCY_LIMIT) return;

    const chunk = chunks[currentIndex++];
    activeRequests++;

    try {
      // 实际上传逻辑
      const formData = new FormData();
      const blob = chunk.fileInfo.file.slice(chunk.startByte, chunk.endByte + 1);
      formData.append("chunk", blob);

      chunk.status = "uploading";
      chunk.fileInfo.status = "uploading";
      // 使用查询参数传递数据
      await axios.post("http://localhost:3000/api/upload-chunk", formData, {
        params: {
          // 添加查询参数
          fileId: chunk.fileInfo.id,
          chunkIndex: chunk.index.toString(),
        },
        headers: { "Content-Type": "multipart/form-data" },
      });
      chunk.status = "done";

      // 更新计数器
      const fileId = chunk.fileInfo.id;
      const newCount = (uploadedChunksMap.get(fileId) || 0) + 1;
      uploadedChunksMap.set(fileId, newCount);
      chunk.fileInfo.progress = ((newCount / totalChunksMap.get(fileId)) * 100).toFixed(2);

      // 检查是否完成
      if (newCount === totalChunksMap.get(fileId)) {
        const file = files.value.find((f) => f.id === fileId);
        if (file) {
          file.status = "processing";
          await axios.post("http://localhost:3000/api/merge", {
            fileId,
            fileName: file.file.name, // 添加文件名
          });
          file.status = "completed";
        }
      }
    } catch (error) {
      console.error("分块上传失败:", error);
      // 可选：重试机制
      if (chunk.retryCount === undefined) chunk.retryCount = 0;
      if (chunk.retryCount < 3) {
        chunk.retryCount++;
        chunks.push(chunk); // 重新加入队列
      }
    } finally {
      activeRequests--;
      _request(); // 处理下一分块
    }
  }

  // 5. 启动上传
  for (let i = 0; i < CONCURRENCY_LIMIT; i++) {
    _request();
  }
}

function clearFiles() {
  files.value = [];
  fileInputKey.value++;
  if (fileInput.value) fileInput.value.value = "";
}
const formatSize = (bytes: number) => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};
</script>

<style scoped>
@import "tailwindcss";
button {
  @apply h-10 w-20 rounded-sm border-1 bg-stone-300 hover:brightness-125;
  @apply disabled:bg-red-500 disabled:text-stone-500;
}
</style>
