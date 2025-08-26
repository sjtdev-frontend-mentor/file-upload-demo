const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const app = express();

app.use(cors());
app.use(express.json());

// 确保上传目录存在
const uploadDir = path.join(__dirname, "ReceivedFiles");
const tempDir = path.join(uploadDir, "temp");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// 分片上传处理
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // 从查询参数获取 fileId
    const fileId = req.query.fileId;
    if (!fileId) return cb(new Error("缺少 fileId 参数"), "");

    const chunkDir = path.join(tempDir, fileId);
    if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir);
    cb(null, chunkDir);
  },
  filename: (req, file, cb) => {
    // 从查询参数获取 chunkIndex
    const chunkIndex = req.query.chunkIndex;
    if (!chunkIndex) return cb(new Error("缺少 chunkIndex 参数"), "");

    cb(null, `${chunkIndex}.chunk`);
  },
});

const uploadChunk = multer({ storage: chunkStorage });

// 分片上传接口
app.post("/api/upload-chunk", uploadChunk.single("chunk"), (req, res) => {
  // 从查询参数获取数据
  const { fileId, chunkIndex } = req.query;

  res.status(200).json({
    success: true,
    fileId,
    chunkIndex,
    message: `分片 ${chunkIndex} 上传成功`,
  });
});

// 合并分片接口
app.post("/api/merge", async (req, res) => {
  const { fileId, fileName } = req.body;
  if (!fileId || !fileName) {
    return res.status(400).json({ error: "缺少 fileId 或 fileName 参数" });
  }
  const chunkDir = path.join(tempDir, fileId);

  try {
    // 检查分片目录是否存在
    if (!fs.existsSync(chunkDir)) {
      return res.status(404).json({ error: "分片目录不存在" });
    }

    // 获取所有分片文件并按索引排序
    const chunks = fs
      .readdirSync(chunkDir)
      .filter((name) => name.endsWith(".chunk"))
      .sort((a, b) => {
        const aIndex = parseInt(a.split(".")[0]);
        const bIndex = parseInt(b.split(".")[0]);
        return aIndex - bIndex;
      });

    // 创建最终文件
    const finalFilePath = path.join(uploadDir, fileName);
    const writeStream = fs.createWriteStream(finalFilePath);

    // 合并所有分片
    for (const chunk of chunks) {
      const chunkPath = path.join(chunkDir, chunk);
      const data = fs.readFileSync(chunkPath);
      writeStream.write(data);
    }

    writeStream.end();

    // 清理临时文件
    fs.rmSync(chunkDir, { recursive: true, force: true });

    res.json({
      success: true,
      url: `http://localhost:3000/ReceivedFiles/${fileName}`,
      fileName,
      fileId,
    });
  } catch (error) {
    console.error("合并错误:", error);
    res.status(500).json({ error: "文件合并失败" });
  }
});

// 静态文件服务
app.use("/ReceivedFiles", express.static(uploadDir));

app.listen(3000, () => console.log("服务器运行中..."));
