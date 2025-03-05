import axios from "axios";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, ScanCommand, DeleteCommand } from "@aws-sdk/client-dynamodb";

// Initialize clients for S3 and DynamoDB
const s3 = new S3Client({ region: "ap-southeast-2" }); // Change to your region
const dynamoDb = new DynamoDBClient({ region: "ap-southeast-2" });

// Environment variables
const taskTrackTable = process.env.TASK_TRACK_TABLE;
const lbUrl = process.env.LB_URL;
const processedBucket = process.env.PROCESSED_BUCKET;

export const handler = async (event) => {
  let taskId;
  
  try {
    // Scan DynamoDB to find tasks
    const scanParams = { TableName: taskTrackTable, Limit: 1 };
    const scanResult = await dynamoDb.send(new ScanCommand(scanParams));

    if (scanResult.Items && scanResult.Items.length > 0) {
      taskId = scanResult.Items[0].taskId;
    } else {
      console.log("No task found, returning");
      return;
    }

    console.log(`TaskId: ${taskId}`);

    // Get task info
    const { data: taskInfo } = await axios.get(`http://${lbUrl}:3000/task/${taskId}/info`);
    
    if (taskInfo.status.code === 40) {
      console.log(`TaskId ${taskId} complete`);

      // Download task files
      const { data: fileStream } = await axios.get(`http://${lbUrl}:3000/task/${taskId}/download/all.zip`, { responseType: "stream" });

      // Delete task from DynamoDB
      const deleteParams = { TableName: taskTrackTable, Key: { taskId } };
      await dynamoDb.send(new DeleteCommand(deleteParams));
      console.log("Task deleted from DynamoDB");

      // Upload to S3
      const uploadParams = {
        Bucket: processedBucket,
        Key: "all.zip",
        Body: fileStream,
      };
      await s3.send(new PutObjectCommand(uploadParams));
      console.log("File uploaded to S3");
    }
  } catch (error) {
    console.error("Error processing task:", error);
  }
};
