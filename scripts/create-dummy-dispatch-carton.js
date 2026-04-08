const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

const connectDB = require("../config/db");
const CartonManagement = require("../models/cartonManagement");
const Device = require("../models/device");
const DeviceTest = require("../models/deviceTestModel");
const Process = require("../models/process");
const Product = require("../models/Products");
const OrderConfirmationNumber = require("../models/orderConfirmationNumber");

const loadEnv = () => {
  const env = process.env.NODE_ENV || "development";
  const envFile = `.env.${env}`;
  const envPath = path.resolve(__dirname, "..", envFile);
  const fallbackPath = path.resolve(__dirname, "..", ".env");

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`Loaded ${envFile}`);
  } else if (fs.existsSync(fallbackPath)) {
    dotenv.config({ path: fallbackPath });
    console.log("Loaded .env");
  } else {
    console.warn("No .env file found. Using process env.");
  }
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const parsed = {
    dryRun: false,
    processRef: "",
    count: 5,
    cartonSerial: "",
    prefix: "DSPTEST",
    modelName: "",
  };

  for (const arg of args) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg.startsWith("--process=")) {
      parsed.processRef = String(arg.slice("--process=".length) || "").trim();
      continue;
    }
    if (arg.startsWith("--count=")) {
      const count = Number.parseInt(arg.slice("--count=".length), 10);
      if (Number.isFinite(count) && count > 0) {
        parsed.count = count;
      }
      continue;
    }
    if (arg.startsWith("--carton=")) {
      parsed.cartonSerial = String(arg.slice("--carton=".length) || "").trim();
      continue;
    }
    if (arg.startsWith("--prefix=")) {
      parsed.prefix = String(arg.slice("--prefix=".length) || "").trim() || "DSPTEST";
      continue;
    }
    if (arg.startsWith("--model=")) {
      parsed.modelName = String(arg.slice("--model=".length) || "").trim();
    }
  }

  return parsed;
};

const padNumeric = (value, length) => String(value).replace(/\D/g, "").padStart(length, "0").slice(-length);

const findPackagingData = (processDoc, productDoc) => {
  const processStages = Array.isArray(processDoc?.stages) ? processDoc.stages : [];
  for (const stage of processStages) {
    const subSteps = Array.isArray(stage?.subSteps) ? stage.subSteps : [];
    for (const step of subSteps) {
      const packagingData = step?.packagingData || null;
      if (step?.isPackagingStatus || Number(packagingData?.maxCapacity || 0) > 0) {
        return packagingData || {};
      }
    }
  }

  const productStages = Array.isArray(productDoc?.stages) ? productDoc.stages : [];
  for (const stage of productStages) {
    const subSteps = Array.isArray(stage?.subSteps) ? stage.subSteps : [];
    for (const step of subSteps) {
      const packagingData = step?.packagingData || null;
      if (step?.isPackagingStatus || Number(packagingData?.maxCapacity || 0) > 0) {
        return packagingData || {};
      }
    }
  }

  return {};
};

const resolveProcess = async (processRef) => {
  if (!processRef) {
    throw new Error("Pass --process=<process _id or processID>");
  }

  const query = mongoose.Types.ObjectId.isValid(processRef)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(processRef) }, { processID: processRef }] }
    : { processID: processRef };

  const processDoc = await Process.findOne(query).lean();
  if (!processDoc) {
    throw new Error(`Process not found for reference: ${processRef}`);
  }

  return processDoc;
};

const resolveModelName = async ({ processDoc, productDoc, requestedModelName }) => {
  const orderConfirmationNo = String(processDoc?.orderConfirmationNo || "").trim();
  const existingOc = orderConfirmationNo
    ? await OrderConfirmationNumber.findOne({ orderConfirmationNo }).lean()
    : null;

  const fallbackModelName =
    String(requestedModelName || "").trim() ||
    String(existingOc?.modelName || "").trim() ||
    String(productDoc?.name || "").trim() ||
    String(processDoc?.name || "").trim() ||
    "Dummy Dispatch Model";

  if (orderConfirmationNo) {
    const needsSync = !existingOc || !String(existingOc.modelName || "").trim();
    if (needsSync) {
      await OrderConfirmationNumber.updateOne(
        { orderConfirmationNo },
        {
          $set: {
            customerName: String(existingOc?.customerName || "Test Customer").trim() || "Test Customer",
            modelName: fallbackModelName,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }

  return fallbackModelName;
};

const buildIdentifiers = ({ prefix, count }) => {
  const seed = Date.now().toString();
  const cartonSerial = `${prefix}-CARTON-${seed}`;
  const rows = [];

  for (let index = 0; index < count; index += 1) {
    const sequence = `${seed}${index + 1}`;
    rows.push({
      serialNo: `28${padNumeric(sequence, 9)}`,
      imeiNo: padNumeric(`86${sequence}`, 15),
      ccid: padNumeric(`899149${sequence}`, 20),
    });
  }

  return { cartonSerial, rows };
};

const main = async () => {
  const { dryRun, processRef, count, cartonSerial: requestedCartonSerial, prefix, modelName: requestedModelName } = parseArgs();

  loadEnv();
  await connectDB();

  try {
    const processDoc = await resolveProcess(processRef);
    const productDoc = processDoc?.selectedProduct
      ? await Product.findById(processDoc.selectedProduct).lean()
      : null;
    const packagingData = findPackagingData(processDoc, productDoc);
    const safeCount = Math.max(1, count);
    const resolvedModelName = await resolveModelName({ processDoc, productDoc, requestedModelName });

    const identifiers = buildIdentifiers({ prefix: prefix.replace(/\s+/g, "").toUpperCase(), count: safeCount });
    const cartonSerial = requestedCartonSerial || identifiers.cartonSerial;

    const existingCarton = await CartonManagement.findOne({ cartonSerial }).lean();
    if (existingCarton) {
      throw new Error(`Carton serial already exists: ${cartonSerial}`);
    }

    const serials = identifiers.rows.map((row) => row.serialNo);
    const duplicateDevices = await Device.find({ serialNo: { $in: serials } }).select("serialNo").lean();
    if (duplicateDevices.length > 0) {
      throw new Error(`Generated serials already exist: ${duplicateDevices.map((row) => row.serialNo).join(", ")}`);
    }

    const deviceDocs = identifiers.rows.map((row) => ({
      productType: processDoc.selectedProduct || null,
      processID: processDoc._id,
      serialNo: row.serialNo,
      imeiNo: row.imeiNo,
      customFields: {
        IMEI: row.imeiNo,
        CCID: row.ccid,
      },
      modelName: resolvedModelName,
      status: "Pass",
      currentStage: "KEEP_IN_STORE",
      dispatchStatus: "READY",
      dispatchInvoiceId: null,
      dispatchDate: null,
      customerName: "",
      warrantyStartDate: null,
      warrantyEndDate: null,
      cartonSerial,
      flowVersion: 1,
      flowStartedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const cartonDoc = {
      cartonSerial,
      processId: processDoc._id,
      devices: [],
      packagingData: {
        packagingType: String(packagingData?.packagingType || "carton"),
        cartonWidth: Number(packagingData?.cartonWidth || 0),
        cartonHeight: Number(packagingData?.cartonHeight || 0),
        cartonDepth: Number(packagingData?.cartonDepth || 0),
        maxCapacity: Number(packagingData?.maxCapacity || safeCount),
        cartonWeight: Number(packagingData?.cartonWeight || 0),
      },
      cartonSize: {
        width: String(packagingData?.cartonWidth || ""),
        height: String(packagingData?.cartonHeight || ""),
        depth: String(packagingData?.cartonDepth || ""),
      },
      maxCapacity: String(packagingData?.maxCapacity || safeCount),
      status: safeCount >= Number(packagingData?.maxCapacity || safeCount) ? "full" : "partial",
      isStickerVerified: true,
      isStickerPrinted: true,
      isWeightVerified: true,
      cartonStatus: "STOCKED",
      weightCarton: String(packagingData?.cartonWeight || ""),
      dispatchStatus: "READY",
      dispatchInvoiceId: null,
      dispatchDate: null,
      dispatchedCustomerName: "",
      gatePassNumber: "",
      reservedAt: null,
      reservedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const testRecords = deviceDocs.map((device) => ({
      processId: processDoc._id,
      productId: processDoc.selectedProduct || undefined,
      serialNo: device.serialNo,
      stageName: "FG to Store",
      status: "Pass",
      flowType: "dummy-dispatch-seed",
      searchType: "Dummy Dispatch Seed",
      logs: [
        {
          stepName: "FG to Store",
          stepType: "dummy-dispatch-seed",
          logData: {
            source: "create-dummy-dispatch-carton.js",
            cartonSerial,
          },
          status: "Pass",
          createdAt: new Date(),
        },
      ],
      timeConsumed: "00:00:10",
      totalBreakTime: "00:00:00",
      startTime: new Date(),
      endTime: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    if (dryRun) {
      console.log(JSON.stringify({
        dryRun,
        process: {
          _id: String(processDoc._id),
          processID: processDoc.processID,
          name: processDoc.name,
          orderConfirmationNo: processDoc.orderConfirmationNo || "",
        },
        modelName: resolvedModelName,
        carton: cartonDoc,
        devices: deviceDocs,
      }, null, 2));
      return;
    }

    const insertedDevices = await Device.insertMany(deviceDocs, { ordered: true });
    cartonDoc.devices = insertedDevices.map((device) => device._id);

    await DeviceTest.insertMany(
      testRecords.map((record, index) => ({ ...record, deviceId: insertedDevices[index]._id })),
      { ordered: true },
    );

    const createdCarton = await CartonManagement.create(cartonDoc);

    console.log(JSON.stringify({
      success: true,
      process: {
        _id: String(processDoc._id),
        processID: processDoc.processID,
        name: processDoc.name,
        orderConfirmationNo: processDoc.orderConfirmationNo || "",
      },
      product: productDoc ? { _id: String(productDoc._id), name: productDoc.name } : null,
      modelName: resolvedModelName,
      carton: {
        _id: String(createdCarton._id),
        cartonSerial: createdCarton.cartonSerial,
        cartonStatus: createdCarton.cartonStatus,
        dispatchStatus: createdCarton.dispatchStatus,
      },
      deviceCount: insertedDevices.length,
      serials: insertedDevices.map((device) => device.serialNo),
      imeis: insertedDevices.map((device) => device.imeiNo),
    }, null, 2));
  } finally {
    await mongoose.connection.close();
  }
};

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error && error.stack ? error.stack : error);
    try {
      await mongoose.connection.close();
    } catch (_) {}
    process.exit(1);
  });
}
