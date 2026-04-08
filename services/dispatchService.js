const mongoose = require("mongoose");
const cartonModel = require("../models/cartonManagement");
const deviceModel = require("../models/device");
const DispatchInvoice = require("../models/dispatchInvoice");
const DispatchInvoiceCarton = require("../models/dispatchInvoiceCarton");
const DispatchInvoiceDevice = require("../models/dispatchInvoiceDevice");
const GatePass = require("../models/gatePass");
const OrderConfirmationNumberModel = require("../models/orderConfirmationNumber");
const WarrantyService = require("./warrantyService");
const GatePassService = require("./gatePassService");

const READY_STATUS = "READY";
const RESERVED_STATUS = "RESERVED";
const DISPATCHED_STATUS = "DISPATCHED";
const STOCKED_STATUS = "STOCKED";

class DispatchService {
  constructor() {
    this.warrantyService = new WarrantyService();
    this.gatePassService = new GatePassService();
  }

  normalizeCartonSerials(values = []) {
    return Array.from(
      new Set(
        values
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )
    );
  }

  normalizePricingSummary(summary = {}) {
    const readNumber = (value) => {
      const parsed = Number.parseFloat(String(value ?? 0));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      currency: String(summary.currency || "INR").trim() || "INR",
      subtotal: readNumber(summary.subtotal),
      taxAmount: readNumber(summary.taxAmount),
      discountAmount: readNumber(summary.discountAmount),
      otherCharges: readNumber(summary.otherCharges),
      grandTotal:
        summary.grandTotal !== undefined
          ? readNumber(summary.grandTotal)
          : readNumber(summary.subtotal) +
            readNumber(summary.taxAmount) +
            readNumber(summary.otherCharges) -
            readNumber(summary.discountAmount),
    };
  }

  normalizeLogisticsDetails(details = {}) {
    const source =
      details && typeof details === "object" && !Array.isArray(details)
        ? details
        : {};

    const normalizeText = (value) => String(value || "").trim();

    return {
      transporterName: normalizeText(source.transporterName),
      transportMode: normalizeText(source.transportMode),
      vehicleNumber: normalizeText(source.vehicleNumber),
      referenceNumber: normalizeText(source.referenceNumber),
    };
  }

  normalizeOrderConfirmationNo(value) {
    return String(value || "").trim();
  }

  toPlainObject(record) {
    if (!record) return record;
    return typeof record.toObject === "function" ? record.toObject() : record;
  }

  async getOrderConfirmationModelMap(orderConfirmationNos = []) {
    const normalizedNumbers = Array.from(
      new Set(
        orderConfirmationNos
          .map((value) => this.normalizeOrderConfirmationNo(value))
          .filter(Boolean)
      )
    );

    if (normalizedNumbers.length === 0) {
      return new Map();
    }

    const records = await OrderConfirmationNumberModel.find({
      orderConfirmationNo: { $in: normalizedNumbers },
    })
      .select("orderConfirmationNo modelName")
      .lean();

    return new Map(
      records.map((record) => [
        this.normalizeOrderConfirmationNo(record.orderConfirmationNo),
        String(record.modelName || "").trim(),
      ])
    );
  }

  async attachResolvedModelNames(cartons = []) {
    const modelMap = await this.getOrderConfirmationModelMap(
      cartons.map((carton) => carton?.processId?.orderConfirmationNo || carton?.orderConfirmationNo)
    );

    return cartons.map((carton) => {
      const plainCarton = this.toPlainObject(carton);
      const orderConfirmationNo = this.normalizeOrderConfirmationNo(
        plainCarton?.processId?.orderConfirmationNo || plainCarton?.orderConfirmationNo
      );
      const resolvedModelName = String(
        plainCarton?.modelName || modelMap.get(orderConfirmationNo) || ""
      ).trim();

      return {
        ...plainCarton,
        modelName: resolvedModelName,
        devices: Array.isArray(plainCarton?.devices)
          ? plainCarton.devices.map((device) => {
              const plainDevice = this.toPlainObject(device);
              return {
                ...plainDevice,
                modelName: String(plainDevice?.modelName || resolvedModelName || "").trim(),
              };
            })
          : [],
      };
    });
  }

  async getReadyCartons(filters = {}) {
    const query = {
      cartonStatus: STOCKED_STATUS,
      $or: [
        { dispatchStatus: READY_STATUS },
        { dispatchStatus: null },
        { dispatchStatus: { $exists: false } },
      ],
    };

    if (filters.processId && mongoose.Types.ObjectId.isValid(String(filters.processId))) {
      query.processId = new mongoose.Types.ObjectId(String(filters.processId));
    }

    if (filters.cartonSerial) {
      query.cartonSerial = { $regex: String(filters.cartonSerial).trim(), $options: "i" };
    }

    const cartons = await cartonModel
      .find(query)
      .populate({ path: "processId", select: "name processID orderConfirmationNo" })
      .populate({ path: "devices", select: "serialNo imeiNo modelName currentStage dispatchStatus cartonSerial" })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    const enrichedCartons = await this.attachResolvedModelNames(cartons);
    return enrichedCartons.map((carton) => this.mapCartonForResponse(carton));
  }

  async getReadyCartonBySerial(cartonSerial) {
    const carton = await cartonModel
      .findOne({ cartonSerial: String(cartonSerial || "").trim() })
      .populate({ path: "processId", select: "name processID orderConfirmationNo" })
      .populate({ path: "devices", select: "serialNo imeiNo modelName currentStage dispatchStatus cartonSerial" })
      .lean();

    if (!carton) {
      const error = new Error("Carton not found");
      error.status = 404;
      throw error;
    }

    const [enrichedCarton] = await this.attachResolvedModelNames([carton]);
    return this.mapCartonForResponse(enrichedCarton || carton);
  }

  mapCartonForResponse(carton) {
    return {
      _id: carton._id,
      cartonSerial: carton.cartonSerial,
      cartonStatus: carton.cartonStatus || carton.status || "",
      dispatchStatus: carton.dispatchStatus || "",
      processId: carton.processId?._id || carton.processId || null,
      processName: carton.processId?.name || carton.processName || "",
      processCode: carton.processId?.processID || "",
      modelName: carton.modelName || "",
      deviceCount: Array.isArray(carton.devices) ? carton.devices.length : 0,
      devices: Array.isArray(carton.devices) ? carton.devices : [],
      dispatchedCustomerName: carton.dispatchedCustomerName || "",
      dispatchDate: carton.dispatchDate || null,
      gatePassNumber: carton.gatePassNumber || "",
      updatedAt: carton.updatedAt,
      createdAt: carton.createdAt,
    };
  }

  async ensureInvoiceNumberAvailable(invoiceNumber, excludeId = null) {
    const query = { invoiceNumber: String(invoiceNumber || "").trim() };
    if (excludeId && mongoose.Types.ObjectId.isValid(String(excludeId))) {
      query._id = { $ne: new mongoose.Types.ObjectId(String(excludeId)) };
    }
    const existing = await DispatchInvoice.findOne(query).lean();
    if (existing) {
      const error = new Error("Invoice number already exists.");
      error.status = 409;
      throw error;
    }
  }

  async loadAndValidateReadyCartons(cartonSerials = []) {
    const normalizedSerials = this.normalizeCartonSerials(cartonSerials);
    if (normalizedSerials.length === 0) {
      const error = new Error("At least one carton is required.");
      error.status = 400;
      throw error;
    }

    const cartons = await cartonModel
      .find({
        cartonSerial: { $in: normalizedSerials },
        cartonStatus: STOCKED_STATUS,
        $or: [
          { dispatchStatus: READY_STATUS },
          { dispatchStatus: null },
          { dispatchStatus: { $exists: false } },
        ],
      })
      .populate({ path: "processId", select: "name processID selectedProduct orderConfirmationNo" })
      .populate({ path: "devices", select: "serialNo imeiNo modelName dispatchStatus currentStage cartonSerial" });

    if (cartons.length !== normalizedSerials.length) {
      const found = new Set(cartons.map((carton) => String(carton.cartonSerial)));
      const missing = normalizedSerials.filter((serial) => !found.has(serial));
      const error = new Error(`Some cartons are not available for dispatch: ${missing.join(", ")}`);
      error.status = 409;
      throw error;
    }

    const enrichedCartons = await this.attachResolvedModelNames(cartons);

    for (const carton of enrichedCartons) {
      if (!Array.isArray(carton.devices) || carton.devices.length === 0) {
        const error = new Error(`Carton ${carton.cartonSerial} has no devices.`);
        error.status = 400;
        throw error;
      }
      const conflictingDevice = carton.devices.find((device) => String(device.dispatchStatus || "") === DISPATCHED_STATUS);
      if (conflictingDevice) {
        const error = new Error(`Carton ${carton.cartonSerial} contains already dispatched device ${conflictingDevice.serialNo}.`);
        error.status = 409;
        throw error;
      }
    }

    return enrichedCartons;
  }

  async reserveCartonsForInvoice(invoice, cartons, userId) {
    const cartonIds = cartons.map((carton) => carton._id);
    const deviceIds = cartons.flatMap((carton) =>
      (Array.isArray(carton.devices) ? carton.devices : []).map((device) => device._id)
    );

    const reserveAt = new Date();
    const cartonUpdate = await cartonModel.updateMany(
      {
        _id: { $in: cartonIds },
        cartonStatus: STOCKED_STATUS,
        $or: [
          { dispatchStatus: READY_STATUS },
          { dispatchStatus: null },
          { dispatchStatus: { $exists: false } },
        ],
      },
      {
        $set: {
          dispatchStatus: RESERVED_STATUS,
          dispatchInvoiceId: invoice._id,
          reservedAt: reserveAt,
          reservedBy: userId || null,
        },
      }
    );

    if (cartonUpdate.modifiedCount !== cartonIds.length) {
      const error = new Error("Some cartons could not be reserved. Please refresh and try again.");
      error.status = 409;
      throw error;
    }

    const deviceUpdate = await deviceModel.updateMany(
      {
        _id: { $in: deviceIds },
        $or: [
          { dispatchStatus: READY_STATUS },
          { dispatchStatus: null },
          { dispatchStatus: { $exists: false } },
        ],
      },
      {
        $set: {
          dispatchStatus: RESERVED_STATUS,
          dispatchInvoiceId: invoice._id,
        },
      }
    );

    if (deviceUpdate.modifiedCount !== deviceIds.length) {
      await cartonModel.updateMany(
        { _id: { $in: cartonIds }, dispatchInvoiceId: invoice._id },
        {
          $set: { dispatchStatus: READY_STATUS },
          $unset: { dispatchInvoiceId: 1, reservedAt: 1, reservedBy: 1 },
        }
      );
      const error = new Error("Some devices could not be reserved. Please refresh and try again.");
      error.status = 409;
      throw error;
    }
  }

  buildSelectedCartonSnapshot(cartons = []) {
    return cartons.map((carton) => ({
      cartonId: carton._id,
      cartonSerial: carton.cartonSerial,
      processId: carton.processId?._id || carton.processId || null,
      processName: carton.processId?.name || "",
      modelName: carton.modelName || "",
      deviceCount: Array.isArray(carton.devices) ? carton.devices.length : 0,
    }));
  }

  async createDraft(payload = {}, userId = null) {
    const invoiceNumber = String(payload.invoiceNumber || "").trim();
    const customerName = String(payload.customerName || "").trim();
    if (!invoiceNumber || !customerName || !payload.dispatchDate) {
      const error = new Error("Invoice number, customer name, and dispatch date are required.");
      error.status = 400;
      throw error;
    }

    await this.ensureInvoiceNumberAvailable(invoiceNumber);
    const cartons = await this.loadAndValidateReadyCartons(payload.cartonSerials || []);
    const selectedCartons = this.buildSelectedCartonSnapshot(cartons);
    const totalQuantity = selectedCartons.reduce((sum, carton) => sum + Number(carton.deviceCount || 0), 0);

    const invoice = await DispatchInvoice.create({
      invoiceNumber,
      customerName,
      contactPerson: String(payload.contactPerson || "").trim(),
      customerEmail: String(payload.customerEmail || "").trim(),
      customerPhone: String(payload.customerPhone || "").trim(),
      ewayBillNo: String(payload.ewayBillNo || "").trim(),
      logisticsDetails: this.normalizeLogisticsDetails(payload.logisticsDetails || {}),
      invoiceDate: payload.invoiceDate || payload.dispatchDate,
      dispatchDate: payload.dispatchDate,
      remarks: String(payload.remarks || "").trim(),
      pricingSummary: this.normalizePricingSummary(payload.pricingSummary || {}),
      selectedCartons,
      selectedCartonCount: selectedCartons.length,
      totalQuantity,
      reservedAt: new Date(),
      createdBy: userId || null,
      updatedBy: userId || null,
    });

    try {
      await this.reserveCartonsForInvoice(invoice, cartons, userId);
      return this.getInvoiceById(invoice._id);
    } catch (error) {
      await DispatchInvoice.deleteOne({ _id: invoice._id });
      throw error;
    }
  }

  async releaseReservation(invoiceId) {
    const objectId = new mongoose.Types.ObjectId(String(invoiceId));
    await cartonModel.updateMany(
      { dispatchInvoiceId: objectId, dispatchStatus: RESERVED_STATUS },
      {
        $set: { dispatchStatus: READY_STATUS },
        $unset: { dispatchInvoiceId: 1, reservedAt: 1, reservedBy: 1 },
      }
    );

    await deviceModel.updateMany(
      { dispatchInvoiceId: objectId, dispatchStatus: RESERVED_STATUS },
      {
        $set: { dispatchStatus: READY_STATUS },
        $unset: { dispatchInvoiceId: 1 },
      }
    );
  }

  async updateDraft(invoiceId, payload = {}, userId = null) {
    const invoice = await DispatchInvoice.findById(invoiceId);
    if (!invoice) {
      const error = new Error("Dispatch invoice not found.");
      error.status = 404;
      throw error;
    }
    if (invoice.status !== "DRAFT") {
      const error = new Error("Only draft invoices can be updated.");
      error.status = 400;
      throw error;
    }

    if (payload.invoiceNumber && String(payload.invoiceNumber).trim() !== invoice.invoiceNumber) {
      await this.ensureInvoiceNumberAvailable(payload.invoiceNumber, invoice._id);
      invoice.invoiceNumber = String(payload.invoiceNumber).trim();
    }

    if (payload.customerName) invoice.customerName = String(payload.customerName).trim();
    if (payload.contactPerson !== undefined) invoice.contactPerson = String(payload.contactPerson || "").trim();
    if (payload.customerEmail !== undefined) invoice.customerEmail = String(payload.customerEmail || "").trim();
    if (payload.customerPhone !== undefined) invoice.customerPhone = String(payload.customerPhone || "").trim();
    if (payload.ewayBillNo !== undefined) invoice.ewayBillNo = String(payload.ewayBillNo || "").trim();
    if (payload.logisticsDetails !== undefined) invoice.logisticsDetails = this.normalizeLogisticsDetails(payload.logisticsDetails || {});
    if (payload.dispatchDate) invoice.dispatchDate = payload.dispatchDate;
    if (payload.invoiceDate) invoice.invoiceDate = payload.invoiceDate;
    if (payload.remarks !== undefined) invoice.remarks = String(payload.remarks || "").trim();
    if (payload.pricingSummary) invoice.pricingSummary = this.normalizePricingSummary(payload.pricingSummary);

    if (Array.isArray(payload.cartonSerials)) {
      await this.releaseReservation(invoice._id);
      const cartons = await this.loadAndValidateReadyCartons(payload.cartonSerials);
      await this.reserveCartonsForInvoice(invoice, cartons, userId);
      invoice.selectedCartons = this.buildSelectedCartonSnapshot(cartons);
      invoice.selectedCartonCount = invoice.selectedCartons.length;
      invoice.totalQuantity = invoice.selectedCartons.reduce((sum, carton) => sum + Number(carton.deviceCount || 0), 0);
      invoice.reservedAt = new Date();
    }

    invoice.updatedBy = userId || null;
    await invoice.save();
    return this.getInvoiceById(invoice._id);
  }

  async cancelInvoice(invoiceId, userId = null) {
    const invoice = await DispatchInvoice.findById(invoiceId);
    if (!invoice) {
      const error = new Error("Dispatch invoice not found.");
      error.status = 404;
      throw error;
    }
    if (invoice.status !== "DRAFT") {
      const error = new Error("Only draft invoices can be cancelled.");
      error.status = 400;
      throw error;
    }

    await this.releaseReservation(invoice._id);
    invoice.status = "CANCELLED";
    invoice.cancelledAt = new Date();
    invoice.updatedBy = userId || null;
    await invoice.save();
    return this.getInvoiceById(invoice._id);
  }

  async confirmInvoice(invoiceId, userId = null, options = {}) {
    const invoice = await DispatchInvoice.findById(invoiceId);
    if (!invoice) {
      const error = new Error("Dispatch invoice not found.");
      error.status = 404;
      throw error;
    }
    if (invoice.status !== "DRAFT") {
      const error = new Error("Only draft invoices can be confirmed.");
      error.status = 400;
      throw error;
    }

    const cartonIds = invoice.selectedCartons.map((carton) => carton.cartonId).filter(Boolean);
    const cartons = await cartonModel
      .find({
        _id: { $in: cartonIds },
        dispatchInvoiceId: invoice._id,
        dispatchStatus: RESERVED_STATUS,
      })
      .populate({ path: "processId", select: "name processID selectedProduct orderConfirmationNo" })
      .populate({ path: "devices", select: "serialNo imeiNo modelName dispatchStatus currentStage cartonSerial" });

    if (cartons.length !== invoice.selectedCartons.length) {
      const error = new Error("Some reserved cartons are no longer available for this invoice.");
      error.status = 409;
      throw error;
    }

    const enrichedCartons = await this.attachResolvedModelNames(cartons);
    const cartonLookup = new Map(enrichedCartons.map((carton) => [String(carton._id), carton]));
    const orderedCartons = invoice.selectedCartons.map((row) => cartonLookup.get(String(row.cartonId))).filter(Boolean);

    const gatePassNumber = this.gatePassService.generateGatePassNumber();
    invoice.gatePassNumber = gatePassNumber;
    invoice.status = "CONFIRMED";
    invoice.confirmedAt = new Date();
    invoice.updatedBy = userId || null;
    await invoice.save();

    const cartonSnapshots = [];
    const deviceSnapshots = [];

    for (const carton of orderedCartons) {
      const cartonSnapshot = await DispatchInvoiceCarton.create({
        dispatchInvoiceId: invoice._id,
        cartonId: carton._id,
        cartonSerial: carton.cartonSerial,
        processId: carton.processId?._id || carton.processId || null,
        processName: carton.processId?.name || "",
        modelName: carton.modelName || "",
        deviceCount: Array.isArray(carton.devices) ? carton.devices.length : 0,
        statusAtDispatch: carton.cartonStatus || carton.status || "",
        dispatchedAt: invoice.dispatchDate,
      });
      cartonSnapshots.push(cartonSnapshot);

      const warranty = this.warrantyService.calculateWarrantyDates(invoice.dispatchDate);
      const mappedDevices = (carton.devices || []).map((device) => ({
        dispatchInvoiceId: invoice._id,
        dispatchCartonId: cartonSnapshot._id,
        deviceId: device._id,
        serialNo: device.serialNo,
        imeiNo: device.imeiNo || "",
        modelName: device.modelName || carton.modelName || "",
        cartonId: carton._id,
        cartonSerial: carton.cartonSerial,
        customerName: invoice.customerName,
        invoiceNumber: invoice.invoiceNumber,
        dispatchDate: invoice.dispatchDate,
        warrantyStartDate: warranty.warrantyStartDate,
        warrantyEndDate: warranty.warrantyEndDate,
        warrantyMonths: warranty.warrantyMonths,
        status: "DISPATCHED",
      }));
      if (mappedDevices.length > 0) {
        const inserted = await DispatchInvoiceDevice.insertMany(mappedDevices, { ordered: true });
        deviceSnapshots.push(...inserted);
      }

      await cartonModel.updateOne(
        { _id: carton._id, dispatchInvoiceId: invoice._id, dispatchStatus: RESERVED_STATUS },
        {
          $set: {
            dispatchStatus: DISPATCHED_STATUS,
            dispatchDate: invoice.dispatchDate,
            dispatchedCustomerName: invoice.customerName,
            gatePassNumber,
          },
          $unset: { reservedAt: 1, reservedBy: 1 },
        }
      );

      await deviceModel.updateMany(
        { _id: { $in: (carton.devices || []).map((device) => device._id) }, dispatchInvoiceId: invoice._id },
        {
          $set: {
            dispatchStatus: DISPATCHED_STATUS,
            dispatchDate: invoice.dispatchDate,
            customerName: invoice.customerName,
            warrantyStartDate: warranty.warrantyStartDate,
            warrantyEndDate: warranty.warrantyEndDate,
            cartonSerial: carton.cartonSerial,
          },
        }
      );
    }

    const gatePassPayload = this.gatePassService.buildPayload(invoice, cartonSnapshots, deviceSnapshots, options);
    const generatedHtml = this.gatePassService.buildPrintableHtml(gatePassPayload);
    await GatePass.create({
      gatePassNumber,
      dispatchInvoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      customerName: invoice.customerName,
      dispatchDate: invoice.dispatchDate,
      cartonCount: gatePassPayload.cartonCount,
      totalQuantity: gatePassPayload.totalQuantity,
      includeImeiList: gatePassPayload.includeImeiList,
      generatedHtml,
      generatedBy: userId || null,
    });

    return this.getInvoiceById(invoice._id, { includeGatePass: true, includeImeiList: gatePassPayload.includeImeiList });
  }

  async getInvoices(filters = {}) {
    const query = {};
    if (filters.status) query.status = String(filters.status).trim().toUpperCase();
    return DispatchInvoice.find(query).sort({ createdAt: -1 }).lean();
  }

  async getInvoiceById(invoiceId, options = {}) {
    const invoice = await DispatchInvoice.findById(invoiceId).lean();
    if (!invoice) {
      const error = new Error("Dispatch invoice not found.");
      error.status = 404;
      throw error;
    }

    let cartons = [];
    let devices = [];
    let gatePass = null;
    if (invoice.status === "CONFIRMED") {
      cartons = await DispatchInvoiceCarton.find({ dispatchInvoiceId: invoice._id }).sort({ createdAt: 1 }).lean();
      devices = await DispatchInvoiceDevice.find({ dispatchInvoiceId: invoice._id }).sort({ createdAt: 1 }).lean();
      if (options.includeGatePass) {
        gatePass = await GatePass.findOne({ dispatchInvoiceId: invoice._id }).lean();
      }
    }

    return {
      ...invoice,
      selectedCartons: invoice.selectedCartons || [],
      cartons,
      devices,
      gatePass,
      gatePassPayload:
        gatePass && invoice.status === "CONFIRMED"
          ? this.gatePassService.buildPayload(invoice, cartons, devices, {
              includeImeiList: options.includeImeiList ?? gatePass.includeImeiList,
            })
          : null,
    };
  }

  async getGatePass(invoiceId, options = {}) {
    const invoice = await DispatchInvoice.findById(invoiceId).lean();
    if (!invoice) {
      const error = new Error("Dispatch invoice not found.");
      error.status = 404;
      throw error;
    }
    if (invoice.status !== "CONFIRMED") {
      const error = new Error("Gate pass is available only for confirmed invoices.");
      error.status = 400;
      throw error;
    }

    const cartons = await DispatchInvoiceCarton.find({ dispatchInvoiceId: invoice._id }).sort({ createdAt: 1 }).lean();
    const devices = await DispatchInvoiceDevice.find({ dispatchInvoiceId: invoice._id }).sort({ createdAt: 1 }).lean();
    const payload = this.gatePassService.buildPayload(invoice, cartons, devices, options);
    const html = this.gatePassService.buildPrintableHtml(payload);
    return { payload, html };
  }

  async markGatePassPrinted(invoiceId) {
    await GatePass.updateOne({ dispatchInvoiceId: invoiceId }, { $set: { printedAt: new Date() } });
  }

  async checkWarranty(filters = {}) {
    const query = {};
    if (filters.serialNo) query.serialNo = String(filters.serialNo).trim();
    if (filters.imeiNo) query.imeiNo = String(filters.imeiNo).trim();
    if (filters.invoiceNumber) query.invoiceNumber = String(filters.invoiceNumber).trim();
    if (Object.keys(query).length === 0) {
      const error = new Error("Provide serialNo, imeiNo, or invoiceNumber.");
      error.status = 400;
      throw error;
    }
    const records = await DispatchInvoiceDevice.find(query).sort({ createdAt: -1 }).lean();
    return records.map((record) => ({
      ...record,
      warrantyActive:
        record.warrantyStartDate &&
        record.warrantyEndDate &&
        new Date(record.warrantyEndDate).getTime() >= Date.now(),
    }));
  }
}

module.exports = DispatchService;
