const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  stages: [
    {
      stageName: { type: String, required: true },
      managedBy: { type: String, required: false },
      requiredSkill: { type: String, required: true },
      cycleTime: { type: String, required: true },
      upha: { type: String, required: true },
      videoLinks: { type: Array, default: [], required: false },
      sopFile: { type: String, default: "" },
      subSteps: [
        {
          stepName: { type: String, required: false },
          description: { type: String, default: "" },
          stepType: { type: String, required: false, enum: ["manual", "jig"] },
          isPrinterEnable: { type: Boolean, required: false, default: false },
          ngTimeout: { type: Number, required: false, default: 0 },
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
