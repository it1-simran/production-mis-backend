const mongoose = require("mongoose");
const cartonModel = require("../models/cartonManagement");
module.exports = {
  createOrUpdate: async (req, res) => {
    try {
      const { processId, devices, packagingData } = req.body;
      let existingCarton = await cartonModel.findOne({
        processId,
        status: { $in: ["partial", "empty"] },
      });
      if (existingCarton) {
        if (existingCarton.devices.includes(devices[0])) {
          return res.status(400).json({
            status: 400,
            message: "Device already exists in this carton.",
          });
        }
        existingCarton.devices.push(devices[0]);
        if (existingCarton.devices.length >= existingCarton.maxCapacity) {
          existingCarton.status = "full";
        } else {
          existingCarton.status = "partial";
        }
        await existingCarton.save();
        return res.status(200).json({
          status: 200,
          message: "Device added to existing carton",
          carton: existingCarton,
        });
      }

      const newCarton = new cartonModel({
        cartonSerial: `CARTON-${Date.now()}`,
        processId,
        devices,
        packagingData,
        maxCapacity: packagingData.maxCapacity,
        status:
          devices.length >= packagingData.maxCapacity ? "full" : "partial",
      });

      await newCarton.save();

      return res.status(201).json({
        status: 201,
        message: "New carton created",
        carton: newCarton,
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "An error occurred while creating/updating carton.",
        error: error.message,
      });
    }
  },
  getCartonByProcessId: async (req, res) => {
    try {
      const { processId } = req.params;
      const carton = await cartonModel.find({
        processId,
        status: { $in: ["full"] },
        cartonStatus: { $in: [""] },
      });
      if (!carton) {
        return res.status(404).json({ message: "No Carton Found" });
      }
      res.json(carton);
    } catch (error) {
      console.error("Error fetching carton:", error);
      res.status(500).json({ error: "Server error" });
    }
  },
  getPartialCarton: async (req, res) => {
    try {
      const { processId } = req.params;
      const carton = await cartonModel
        .findOne({
          processId: processId,
          status: { $in: ["empty", "partial"] },
          cartonStatus: { $in: [""] },
        })
        .populate("devices");
      if (!carton) {
        return res.status(404).json({ message: "No open carton found." });
      }

      res.status(200).json(carton);
    } catch (error) {
      console.error("Error fetching carton:", error);
      res.status(500).json({ error: "Server error" });
    }
  },

  shiftToPDI: async (req, res) => {
    try {
      const { cartons } = req.body;

      if (!cartons || cartons.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: "No cartons provided" });
      }

      // Update all cartons whose serials match
      const result = await cartonModel.updateMany(
        { cartonSerial: { $in: cartons } }, // filter
        { $set: { cartonStatus: "PDI" } } // update
      );

      return res.status(200).json({
        success: true,
        shifted: result.modifiedCount,
        message: "Cartons shifted to PDI successfully",
      });
    } catch (error) {
      console.error("Error in shiftToPDI:", error);
      return res
        .status(500)
        .json({ success: false, error: "Failed to shift cartons" });
    }
  },
};
