const mongoose = require("mongoose");

const processSchema = new mongoose.Schema({
  name: { type: String, required: true },
  selectedProduct: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "products",
    required: true,
  },
  orderConfirmationNo: { type: String, required: false },
  processID: { type: String, required: true },
  quantity: { type: String, required: true },
  issuedKits: { type: Number, required: false, default: 0 },
  issuedCartons: { type: Number, default: 0 },
  consumedKits: { type: Number, default: 0 },
  consumedCartons: { type: Number, default: 0 },
  descripition: { type: String, required: false },
  fgToStore: { type: Number, required: false, default: 0 },
  stages: [
    {
      stageName: { type: String, required: true },
      managedBy: { type: String, required: false },
      requiredSkill: { type: String, required: true },
      cycleTime: { type: String, required: true },
      videoLinks: { type: Array, default: [], required: false },
      upha: { type: String, required: true },
      sopFile: { type: String, default: "" },
      subSteps: [{
        stepName: { type: String, required: false },
        description: { type: String, default: "" },
        stepType: { type: String, required: false, enum: ["manual", "jig"] },
        ngTimeout: { type: Number, required: false, default: 0 },
        isPrinterEnable: { type: Boolean, required: false, default: false },
        isCheckboxNGStatus: {
          type: Boolean,
          required: false,
          default: false,
        },
        isPackagingStatus: { type: Boolean, required: false, default: false },
        packagingData: {
          packagingType: { type: String, required: false, default: "" },
          cartonWidth: { type: Number, required: false, default: 0 },
          cartonHeight: { type: Number, required: false, default: 0 },
          maxCapacity: { type: Number, required: false, default: 0 },
          cartonWeight: { type: Number, required: false, default: 0 },
        },
        printerFields: [
          {
            isExpanded: { type: Boolean, required: false, default: false },
            dimensions: {
              width: { type: String, required: false, default: "" },
              height: { type: String, required: false, default: "" },
            },
            fields: [
              {
                name: { type: String, required: false, default: "" },
                slug: { type: String, required: false, default: "" },
                x: { type: Number, required: false, default: "" },
                y: { type: Number, required: false, default: "" },
                width: { type: Number, required: false, default: "" },
                height: { type: Number, required: false, default: "" },
                type: { type: String, required: false, default: "" },
                value: { type: String, required: false, default: "" },
                styles: {
                  color: { type: String, required: false, default: "" },
                  fontSize: { type: String, required: false, default: "" },
                  fontStyle: { type: String, required: false, default: "" },
                  fontWeight: { type: String, required: false, default: "" },
                },
              },
            ],
          },
        ],
        ngStatusData: [
          {
            id: { type: String, required: false, default: "" },
            value: { type: String, required: false, default: "" },
          },
        ],
        jigFields: [
          {
            jigName: { type: String, required: false, default: "" },
            validationType: { type: String, required: false, default: "" },
            rangeFrom: { type: Number, default: 0, required: false },
            rangeTo: { type: Number, default: 0, required: false },
            value: { type: String, default: "", required: false },
            lengthFrom: { type: Number, default: 0, required: false },
            lengthTo: { type: Number, default: 0, required: false },
          },
        ],
        stepFields: {
          validationType: { type: String, required: false },
          rangeFrom: { type: Number, default: 0 },
          rangeTo: { type: Number, default: 0 },
          value: { type: String, default: "" },
          actionType: { type: String, required: false, default: "" },
          command: { type: String, required: false, default: "" },
        },
      }],
    },
  ],
  commonStages: [
    {
      stageName: { type: String, required: true },
      managedBy: { type: String, required: false },
      requiredSkill: { type: String, required: true },
    },
  ],
  dispatchStatus: {
    type: String,
    enum: ["dispatched", "not dispatched"],
    default: "not dispatched",
  },
  deliverStatus: {
    type: String,
    enum: ["delivered", "not delivered"],
    default: "not delivered",
  },
  kitStatus: {
    type: String,
    enum: ["issued", "partially_issued", "not_issued"],
    default: "not_issued",
  },
  status: {
    type: String,
    enum: [
      "waiting_schedule",
      "Waiting_Kits_allocation",
      "Waiting_Kits_approval",
      "waiting_for_line_feeding",
      "waiting_for_kits_confirmation",
      "active",
      "down_time_hold",
      "completed",
    ],
    default: "waiting_schedule",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Creating the model from schema
const Process = mongoose.model("process", processSchema);

module.exports = Process;
