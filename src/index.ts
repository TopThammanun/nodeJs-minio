import express, { Request, Response } from "express";
import multer from "multer";
import dotenv from "dotenv";
import * as Minio from "minio";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || "localhost",
  port: parseInt(process.env.MINIO_PORT || "9000"),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || "",
  secretKey: process.env.MINIO_SECRET_KEY || "",
});

const bucket1 = "single-image-bucket";
const bucket2 = "multiple-image-bucket";

const ensureBucketsExist = async () => {
  try {
    const bucket1Exists = await minioClient.bucketExists(bucket1);
    if (!bucket1Exists) {
      await minioClient.makeBucket(bucket1, "us-east-1");
      console.log(`Bucket '${bucket1}' created successfully.`);
    } else {
      console.log(`Bucket '${bucket1}' already exists.`);
    }

    const bucket2Exists = await minioClient.bucketExists(bucket2);
    if (!bucket2Exists) {
      await minioClient.makeBucket(bucket2, "us-east-1");
      console.log(`Bucket '${bucket2}' created successfully.`);
    } else {
      console.log(`Bucket '${bucket2}' already exists.`);
    }
  } catch (err) {
    console.error("Error ensuring buckets exist or creating buckets:", err);
  }
};

ensureBucketsExist();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "uploads";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const requestedFilename = req.body.filename || uuidv4();
    cb(null, requestedFilename + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

app.post(
  "/upload",
  upload.single("image"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const requestedFilename = req.body.filename || req.file.filename; // Use the provided filename if available
    const filePath = path.join("uploads", req.file.filename);

    try {
      const fileStream = fs.createReadStream(filePath);
      const stat = fs.statSync(filePath);

      await minioClient.putObject(
        bucket1,
        requestedFilename,
        fileStream,
        stat.size
      );

      fs.unlinkSync(filePath);

      res.status(200).json({
        message: "Image uploaded successfully to bucket1",
        filename: requestedFilename,
      });
    } catch (err) {
      console.error("Error uploading file to MinIO:", err);
      res
        .status(500)
        .json({ message: "Error uploading file to MinIO", error: err });
    }
  }
);

app.post(
  "/upload-multiple",
  upload.array("images", 10),
  async (req: Request, res: Response) => {
    if (!req.files || !Array.isArray(req.files)) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    const files = req.files as Express.Multer.File[];
    const folderName = req.body.filename || uuidv4();
    const folderPath = path.join("uploads", folderName);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    const uploadResults: { filename: string; url: string }[] = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const newFileName =
          req.body[`filename${i + 1}`] ||
          `${i + 1}${path.extname(file.originalname)}`; // Use requested filenames if provided
        const filePath = path.join(folderPath, newFileName);

        const fileStream = fs.createReadStream(file.path);
        const stat = fs.statSync(file.path);

        const minioFilePath = `${folderName}/${newFileName}`;
        await minioClient.putObject(
          bucket2,
          minioFilePath,
          fileStream,
          stat.size
        );

        fs.unlinkSync(file.path);

        const url = await minioClient.presignedGetObject(
          bucket2,
          minioFilePath,
          3600
        );
        uploadResults.push({ filename: minioFilePath, url });
      }

      res.status(200).json({
        message: "Images uploaded successfully to bucket2",
        folder: folderName,
        files: uploadResults,
      });
    } catch (err) {
      console.error("Error uploading files to MinIO:", err);
      res
        .status(500)
        .json({ message: "Error uploading files to MinIO", error: err });
    }
  }
);

app.get("/get-images/:folder", async (req: Request, res: Response) => {
  const folder = req.params.folder;

  try {
    const objectsList: { filename: string; url: string }[] = [];

    const objectsStream = minioClient.listObjectsV2(
      bucket2,
      `${folder}/`,
      true
    );

    const filePromises: Promise<void>[] = [];

    const files = await new Promise<{ filename: string; url: string }[]>(
      (resolve, reject) => {
        const tempObjects: { filename: string; url: string }[] = [];

        objectsStream.on("data", (obj) => {
          if (!obj.name?.endsWith("/")) {
            const filePromise = minioClient
              .presignedGetObject(bucket2, obj.name as string, 3600)
              .then((url) => {
                tempObjects.push({ filename: obj.name as string, url });
              })
              .catch((err) => {
                console.error(`Error generating URL for ${obj.name}:`, err);
              });

            filePromises.push(filePromise);
          }
        });

        objectsStream.on("end", async () => {
          await Promise.all(filePromises);
          resolve(tempObjects);
        });

        objectsStream.on("error", (err) => {
          console.error("Error listing objects:", err);
          reject(err);
        });
      }
    );

    // Send the final response
    res.status(200).json({
      message: "Successfully retrieved all images in the folder",
      files: files,
    });
  } catch (err) {
    console.error("Error retrieving images:", err);
    res.status(500).json({ message: "Error retrieving images", error: err });
  }
});

app.get("/download/:filename", async (req: Request, res: Response) => {
  const filename = req.params.filename;

  try {
    const url = await minioClient.presignedGetObject(bucket1, filename, 3600);

    res.status(200).json({
      message: "Presigned URL generated successfully from bucket1",
      url: url,
    });
  } catch (err) {
    console.error("Error generating presigned URL:", err);
    res
      .status(500)
      .json({ message: "Error generating presigned URL", error: err });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
