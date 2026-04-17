const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  status: { type: String, enum: ["draft", "active"], default: "active" },
  stages: [
    {
      stageName: { type: String, required: true },
      managedBy: { type: String, required: false },
      requiredSkill: { type: String, required: true },
      cycleTime: { type: String, required: true },
      upha: { type: String, required: true },
      description: { type: String, required: false },
      // Stage-level search type (e.g. "Through Serial" / "Through Jig Stages")
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
      videoLinks: { type: Array, default: [], required: false },
      sopFile: { type: String, default: "" },
      subSteps: [
        {
          stepName: { type: String, required: false },
          description: { type: String, default: "" },
          stepType: { type: String, required: false, enum: ["manual", "jig"] },
          isPrinterEnable: { type: Boolean, required: false, default: false },
          ngTimeout: { type: Number, required: false, default: 0 },
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
              unit: { type: String, required: false, default: "" },
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
        },
      ],
    },
  ],
  commonStages: [
    {
      stageName: { type: String, required: true },
      managedBy: { type: String, required: false },
      requiredSkill: { type: String, required: true },
    },
  ],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Creating the model from schema
const Product = mongoose.model("products", productSchema);

module.exports = Product;



