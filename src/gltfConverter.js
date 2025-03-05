(() => {
  "use strict";
  
  const { S3 } = require("@aws-sdk/client-s3");
  const { IoTTwinMaker } = require("@aws-sdk/client-iot-twinmaker");
  const unzipper = require("unzipper");
  const uuid = require("uuid");
  const fs = require("fs");
  const path = require("path");
  const obj2gltf = require("obj2gltf");

  const s3 = new S3();
  const twinMaker = new IoTTwinMaker();

  const workspaceBucket = process.env.TWINMAKER_WORKSPACE_BUCKET;
  const workspaceId = process.env.TWINMAKER_WORKSPACE_ID;
  
  let processODMFile = true;

  // Main handler function
  exports.handler = async (event) => {
    console.log(event);
    const bucket = process.env.PROCESSED_BUCKET;
    const fileName = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
    console.log(`File name ${fileName}`);

    if (fileName.toLowerCase() !== "all.zip") {
      processODMFile = false;
    }

    const getObjectParams = {
      Bucket: bucket,
      Key: fileName,
    };

    const s3Stream = s3.getObject(getObjectParams).Body.pipe(unzipper.Parse({ forceStream: true }));

    try {
      await deleteTempDir("/tmp");
    } catch (e) {
      console.log("Could not delete /tmp dir, it probably does not exist");
    }

    await fs.promises.mkdir("/tmp/odm_texturing");

    try {
      for await (const file of s3Stream) {
        if (file.type === "File") {
          const filePath = file.path;
          console.log(filePath);

          if (
            filePath.toLowerCase().includes("odm_textured_model") ||
            filePath.toLowerCase().includes("scene_mesh_textured")
          ) {
            const buffer = await file.buffer();
            console.log(buffer);
            await fs.promises.writeFile(`/tmp/${filePath}`, buffer);
          }
        }
        file.autodrain();
      }
    } catch (e) {
      console.error(e);
    }

    const processingOptions = { binary: true };
    let result;

    if (processODMFile) {
      console.log("Processing ODM OBJ file");
      result = await obj2gltf("/tmp/odm_texturing/odm_textured_model_geo.obj", processingOptions);
    } else {
      console.log("Processing DroneDeploy OBJ file");
      result = await obj2gltf("/tmp/scene_mesh_textured.obj", processingOptions);
    }

    console.log(result);

    try {
      // Upload model to S3
      const modelUploadParams = {
        Bucket: workspaceBucket,
        Key: "model.glb",
        Body: result,
      };
      await s3.putObject(modelUploadParams);
      console.log("Uploaded model to workspace bucket");

      // Upload scene metadata to S3
      const sceneMetadata = {
        Bucket: workspaceBucket,
        Key: "scene.json",
        Body: JSON.stringify(generateSceneMetadata()),
      };
      await s3.putObject(sceneMetadata);
      console.log("Uploaded scene metadata to workspace bucket");

      // Create a scene in IoT TwinMaker
      const createSceneParams = {
        workspaceId,
        sceneId: `PhotogrammeteryScene-${uuid.v4()}`,
        contentLocation: `s3://${workspaceBucket}/scene.json`,
      };
      await twinMaker.createScene(createSceneParams);
      console.log("Scene created in TwinMaker");
    } catch (e) {
      console.error("Error during upload or scene creation", e);
    }
  };

  // Helper functions
  const deleteTempDir = async (dir) => {
    const files = await fs.promises.readdir(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        await deleteTempDir(filePath);
      } else {
        await fs.promises.unlink(filePath);
      }
    }
    await fs.promises.rmdir(dir);
  };

  const generateSceneMetadata = () => ({
    specVersion: "1.0",
    version: "1",
    unit: "meters",
    properties: {},
    nodes: [
      {
        name: "model",
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        transformConstraint: {},
        children: [1],
        components: [
          {
            type: "ModelRef",
            uri: `s3://${workspaceBucket}/model.glb`,
            modelType: "GLB",
          },
        ],
        properties: {},
      },
      {
        name: "Light",
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        transformConstraint: {},
        components: [
          {
            type: "Light",
            lightType: "Ambient",
            lightSettings: { color: 16777215, intensity: 1, castShadow: true },
          },
        ],
        properties: {},
      },
    ],
    rootNodeIndexes: [0],
  });
})();
