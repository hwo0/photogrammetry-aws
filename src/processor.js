(() => {
  "use strict";

  const { S3 } = require("@aws-sdk/client-s3");
  const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
  const axios = require("axios");
  const formData = require("form-data");
  const unzipper = require("unzipper");
  const uuid = require("uuid");

  const s3 = new S3();
  const dynamoDbClient = DynamoDBDocumentClient.from(new (require("@aws-sdk/client-dynamodb")).DynamoDB());
  
  const taskTrackTable = process.env.TASK_TRACK_TABLE;
  const landingBucket = process.env.LANDING_BUCKET;
  const lbUrl = process.env.LB_URL;

  // Main handler function
  exports.handler = async (event) => {
    console.log(event);

    const getObjectParams = {
      Bucket: landingBucket,
      Key: decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " ")),
    };

    const s3Stream = s3.getObject(getObjectParams).Body.pipe(unzipper.Parse({ forceStream: true }));

    // Initialize Task
    const { data } = await axios.post(`http://${lbUrl}:3000/task/new/init`, {
      name: `Task-${uuid.v4()}`,
    }, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

    const taskId = data.uuid;

    // Add task to DynamoDB
    await dynamoDbClient.send(new PutCommand({
      TableName: taskTrackTable,
      Item: { taskId, inProgress: true },
    }));

    try {
      for await (const file of s3Stream) {
        if (file.type === "File") {
          const filePath = file.path;
          console.log(filePath);

          const fileBuffer = await file.buffer();
          const form = new formData();
          form.append("images", fileBuffer, { filename: filePath });

          await axios.post(`http://${lbUrl}:3000/task/new/upload/${taskId}`, form, {
            headers: form.getHeaders(),
          });
        }
        file.autodrain();
      }
    } catch (e) {
      console.error(e);
    }

    // Commit the task
    await axios.post(`http://${lbUrl}:3000/task/new/commit/${taskId}`);
    console.log("Task committed");
  };
})();
