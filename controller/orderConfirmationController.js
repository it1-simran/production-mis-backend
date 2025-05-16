const mongoose = require("mongoose");
const OrderConfirmationNumberModel = require("../models/orderConfirmationNumber");
module.exports = {
  create: async (req, res) => {
    try {
      const data = req.body;

      // ✅ Update logic
      if (data?.id) {
        const updatedOrder =
          await OrderConfirmationNumberModel.findByIdAndUpdate(data.id, data, {
            new: true,
          });

        if (!updatedOrder) {
          return res.status(404).json({
            status: 404,
            message: "Order Confirmation Number not found",
          });
        }

        return res.status(200).json({
          status: 200,
          message: "Order Confirmation Number updated successfully",
          orderConfirmation: updatedOrder,
        });
      }

      // ✅ Create logic
      const newOrder = new OrderConfirmationNumberModel(data);
      const savedOrder = await newOrder.save(); // _id is generated here

      return res.status(200).json({
        status: 200,
        message: "Order Confirmation Number created successfully",
        orderConfirmation: savedOrder,
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(200).json({
          status: 204,
          message: "Order Confirmation Number already exists.",
          field: Object.keys(error.keyPattern)[0],
        });
      }
      console.error("Order Create/Update Error:", error);
      return res.status(500).json({ status: 500, error: error.message });
    }
  },
  //   create: async (req, res) => {
  //     try {
  //       const data = req?.body;
  //       if (data.id) {
  //         const updatedOrder =
  //           await OrderConfirmationNumberModel.findByIdAndUpdate(data.id, data, {
  //             new: true,
  //           });

  //         if (!updatedOrder) {
  //           return res.status(404).json({
  //             status: 404,
  //             message: "Order Confirmation Number not found",
  //           });
  //         }

  //         return res.status(200).json({
  //           status: 200,
  //           message: "Order Confirmation Number updated successfully",
  //           orderConfirmation: updatedOrder,
  //         });
  //       }
  //       const orderConfirmation = new OrderConfirmationNumberModel(data);
  //       const savedOrderConfirmationNumber = await orderConfirmation.save();

  //       return res.status(200).json({
  //         status: 200,
  //         message: "Order Confirmation Number created successfully",
  //         orderConfirmation: savedOrderConfirmationNumber,
  //       });
  //     } catch (error) {
  //       return res.status(500).json({ status: 500, error: error.message });
  //     }
  //   },
  view: async (req, res) => {
    try {
      const getOrderConfirmationNo = await OrderConfirmationNumberModel.find();
      return res.status(200).json({
        status: 200,
        status_msg: "Order Confirmation Fetched Sucessfully!!",
        getOrderConfirmationNo,
      });
    } catch (error) {
      console.error("Error fetching Menu details:", error.message);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
};
