const mongoose = require("mongoose");

const OrderConfirmationNumberSchema = new mongoose.Schema({
    orderConfirmationNo: { type: String, required: true ,unique: true,},
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

const OrderConfirmationModel = mongoose.model(
    "orderConfirmationNumbers",
    OrderConfirmationNumberSchema
  );
  
  module.exports = OrderConfirmationModel;
  