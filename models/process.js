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
  consumedKits: { type: Number, required: false, default: 0 },
  consumedCartons: { type: Number, required: false, default: 0 },
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
      description: { type: String, required: false },
      searchType: { type: String, required: false, default: "" },
      jigStageFields: [
        {
          jigName: { type: String, required: false, default: "" },
          validationType: { type: String, required: false, default: "value" },
          rangeFrom: { type: Number, default: 0, required: false },
          rangeTo: { type: Number, default: 0, required: false },
          value: { type: String, default: "", required: false },
          lengthFrom: { type: Number, default: 0, required: false },
          lengthTo: { type: Number, default: 0, required: false },
        },
      ],
      sopFile: { type: String, default: "" },
      subSteps: [{
        stepName: { type: String, required: false },
        description: { type: String, default: "" },
        stepType: { type: String, required: false, enum: ["manual", "jig"] },
        ngTimeout: { type: Number, required: false, default: 0 },
        isPrinterEnable: { type: Boolean, required: false, default: false },
        disabled: { type: Boolean, default: false },
        isCheckboxNGStatus: {
          type: Boolean,
          required: false,
          default: false,
        },
        isPackagingStatus: { type: Boolean, required: false, default: false },
        packagingData: {
          packagingType: { type: String, required: false, default: "" },
          cartonLength: { type: Number, required: false, default: 0 },
          cartonWidth: { type: Number, required: false, default: 0 },
          cartonHeight: { type: Number, required: false, default: 0 },
          cartonDepth: { type: Number, required: false, default: 0 },
          maxCapacity: { type: Number, required: false, default: 0 },
          cartonWeight: { type: Number, required: false, default: 0 },
          cartonWeightTolerance: { type: Number, required: false, default: 0 },
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
                  sourceFields: [
                    {
                      name: { type: String, required: false, default: "" },
                      slug: { type: String, required: false, default: "" },
                    },
                  ],
                  x: { type: Number, required: false, default: "" },
                y: { type: Number, required: false, default: "" },
                width: { type: Number, required: false, default: "" },
                height: { type: Number, required: false, default: "" },
                type: { type: String, required: false, default: "" },
                value: { type: String, required: false, default: "" },
                displayValue: { type: Boolean, required: false, default: true },
                barWidth: { type: Number, required: false, default: 1 },
                barWidthMm: { type: Number, required: false, default: 0.25 },
                barHeight: { type: Number, required: false, default: 0 },
                barHeightMm: { type: Number, required: false, default: 3.3 },
                barDensity: { type: Number, required: false, default: 0.636 },
                barLength: { type: Number, required: false, default: 0 },
                format: { type: String, required: false, default: "" },
                codeSet: { type: String, required: false, default: "Auto" },
                textEncoding: { type: String, required: false, default: "US-ASCII" },
                includeCheckDigit: { type: Boolean, required: false, default: false },
                hibc: { type: Boolean, required: false, default: false },
                gs1_128: { type: Boolean, required: false, default: false },
                lineColor: { type: String, required: false, default: "#000000" },
                background: { type: String, required: false, default: "transparent" },
                margin: { type: Number, required: false, default: 0 },
                fontSize: { type: Number, required: false, default: 12 },
                textMargin: { type: Number, required: false, default: 2 },
                valueFontBold: { type: Boolean, required: false, default: false },
                styles: {
                  color: { type: String, required: false, default: "" },
                  fontSize: { type: String, required: false, default: "" },
                  fontStyle: { type: String, required: false, default: "" },
                  fontWeight: { type: String, required: false, default: "" },
                  textAlign: { type: String, required: false, default: "" },
                  lineHeight: { type: String, required: false, default: "" },
                  letterSpacing: { type: String, required: false, default: "" },
                  backgroundColor: { type: String, required: false, default: "" },
                  borderColor: { type: String, required: false, default: "" },
                  borderWidth: { type: String, required: false, default: "" },
                  borderRadius: { type: String, required: false, default: "" },
                  padding: { type: String, required: false, default: "" },
                  transform: { type: String, required: false, default: "" },
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



