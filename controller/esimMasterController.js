const EsimMaster = require("../models/EsimMaster");
const EsimMake = require("../models/EsimMake");
const EsimProfile = require("../models/EsimProfile");
const EsimApn = require("../models/EsimApn");

const ESIM_MASTER_SELECT = "ccid esimMake profile1 profile2 apnProfile1 apnProfile2 remarks isEditable createdAt updatedAt";

const shouldLogEsimCcidTimings = String(process.env.LOG_ESIM_CCID_TIMINGS || "").toLowerCase() === "true";
const logEsimCcidTimings = (timings = {}, meta = {}) => {
  if (!shouldLogEsimCcidTimings) return;
  try {
    console.info("[esim-ccid-timing]", JSON.stringify({ ...meta, ...timings }));
  } catch (error) {
    console.info("[esim-ccid-timing]", { ...meta, ...timings });
  }
};

const escapeRegex = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const parsePositiveInt = (value, fallback, max = 250) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

// esim-master stores its own denormalized apnProfile1/2 strings, which can drift out of sync
// (e.g. wrong casing from a bulk upload) with the canonical name in EsimApn. Re-resolve them
// live from EsimApn on every read so the master list always reflects the source of truth.
const attachCanonicalApnNames = async (rows) => {
  const list = Array.isArray(rows) ? rows : [rows];
  const pairKey = (make, profile) => `${make || ""}|${profile || ""}`;

  const makes = [...new Set(list.map((row) => row?.esimMake).filter(Boolean))];
  if (makes.length === 0) return rows;

  const apnDocs = await EsimApn.find({ esimMake: { $in: makes } })
    .select("esimMake esimProfile1 apnName")
    .lean();
  const apnMap = new Map(apnDocs.map((doc) => [pairKey(doc.esimMake, doc.esimProfile1), doc.apnName]));

  list.forEach((row) => {
    if (!row) return;
    const apn1 = apnMap.get(pairKey(row.esimMake, row.profile1));
    const apn2 = apnMap.get(pairKey(row.esimMake, row.profile2));
    if (apn1) row.apnProfile1 = apn1;
    if (apn2) row.apnProfile2 = apn2;
  });

  return rows;
};

module.exports = {
  bulkCreate: async (req, res) => {
    try {
      const data = req.body;

      if (!Array.isArray(data) || data.length === 0) {
        return res.status(400).json({
          status: 400,
          message: "Invalid data. Expected a non-empty array of objects.",
        });
      }

      const ops = data.map((item) => ({
        updateOne: {
          filter: { ccid: item.ccid },
          update: { $set: { ...item, updatedAt: new Date() } },
          upsert: true,
        },
      }));

      const result = await EsimMaster.bulkWrite(ops, { ordered: false });

      return res.status(201).json({
        status: 201,
        message: "ESimmaster records created/updated successfully",
        inserted: result.upsertedCount,
        updated: result.modifiedCount,
      });
    } catch (error) {
      if (error.name === "MongoBulkWriteError") {
        return res.status(400).json({
          status: 400,
          message: "Bulk write partially failed.",
          error: error.message,
        });
      }

      console.error("Error in ESIM Master bulk create:", error);
      return res.status(500).json({
        status: 500,
        message: "Server error",
        error: error.message,
      });
    }
  },

  view: async (req, res) => {
    try {
      const page = parsePositiveInt(req.query.page, 1, 100000);
      const pageSize = parsePositiveInt(req.query.pageSize, 25, 200);
      const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
      const includeAll = req.query.all === "1";

      const filter = query
        ? {
            $or: [
              { ccid: { $regex: escapeRegex(query), $options: "i" } },
              { esimMake: { $regex: escapeRegex(query), $options: "i" } },
            ],
          }
        : {};

      if (includeAll) {
        const esimMasters = await EsimMaster.find(filter)
          .select(ESIM_MASTER_SELECT)
          .sort({ createdAt: -1 })
          .lean();
        await attachCanonicalApnNames(esimMasters);

        return res.status(200).json({
          status: 200,
          message: "ESIM Master records fetched successfully",
          data: esimMasters,
          pagination: {
            page: 1,
            pageSize: esimMasters.length,
            total: esimMasters.length,
            totalPages: esimMasters.length > 0 ? 1 : 0,
            hasNextPage: false,
            hasPreviousPage: false,
          },
        });
      }

      const [esimMasters, total] = await Promise.all([
        EsimMaster.find(filter)
          .select(ESIM_MASTER_SELECT)
          .sort({ createdAt: -1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .lean(),
        EsimMaster.countDocuments(filter),
      ]);
      await attachCanonicalApnNames(esimMasters);

      const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;

      return res.status(200).json({
        status: 200,
        message: "ESIM Master records fetched successfully",
        data: esimMasters,
        pagination: {
          page,
          pageSize,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      });
    } catch (error) {
      console.error("Error in ESIM Master view:", error);
      return res.status(500).json({
        status: 500,
        message: "Server error",
        error: error.message,
      });
    }
  },

  create: async (req, res) => {
    try {
      const { ccid, esimMake, profile1, profile2, apnProfile1, apnProfile2, remarks } = req.body;
      const newEntry = new EsimMaster({ ccid, esimMake, profile1, profile2, apnProfile1, apnProfile2, remarks });
      await newEntry.save();
      return res.status(201).json({
        status: 201,
        message: "ESIM Master created successfully",
        data: newEntry,
      });
    } catch (error) {
      console.error("Error in ESIM Master create:", error);
      if (error.code === 11000) {
        return res.status(400).json({ status: 400, message: "CCID already exists" });
      }
      return res.status(500).json({
        status: 500,
        message: "Server error",
        error: error.message,
      });
    }
  },

  update: async (req, res) => {
    try {
      const { id } = req.params;
      const updateData = req.body;
      updateData.updatedAt = Date.now();
      const updated = await EsimMaster.findByIdAndUpdate(id, updateData, { new: true });
      if (!updated) {
        return res.status(404).json({ status: 404, message: "Record not found" });
      }
      return res.status(200).json({
        status: 200,
        message: "ESIM Master updated successfully",
        data: updated,
      });
    } catch (error) {
      console.error("Error in ESIM Master update:", error);
      return res.status(500).json({
        status: 500,
        message: "Server error",
        error: error.message,
      });
    }
  },

  delete: async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await EsimMaster.findByIdAndDelete(id);
      if (!deleted) {
        return res.status(404).json({ status: 404, message: "Record not found" });
      }
      return res.status(200).json({
        status: 200,
        message: "ESIM Master deleted successfully",
      });
    } catch (error) {
      console.error("Error in ESIM Master delete:", error);
      return res.status(500).json({
        status: 500,
        message: "Server error",
        error: error.message,
      });
    }
  },

  bulkDelete: async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ status: 400, message: "Invalid IDs provided" });
      }
      const result = await EsimMaster.deleteMany({ _id: { $in: ids } });
      return res.status(200).json({
        status: 200,
        message: `${result.deletedCount} records deleted successfully`,
      });
    } catch (error) {
      console.error("Error in ESIM Master bulk delete:", error);
      return res.status(500).json({
        status: 500,
        message: "Server error",
        error: error.message,
      });
    }
  },

  // Delete records by CCID list (from Excel upload)
  bulkDeleteByCcid: async (req, res) => {
    try {
      const { ccids } = req.body;
      if (!Array.isArray(ccids) || ccids.length === 0) {
        return res.status(400).json({ status: 400, message: "Invalid CCIDs provided" });
      }
      const result = await EsimMaster.deleteMany({ ccid: { $in: ccids } });
      return res.status(200).json({
        status: 200,
        message: `${result.deletedCount} records deleted successfully`,
        deletedCount: result.deletedCount,
      });
    } catch (error) {
      console.error("Error in ESIM Master bulk delete by CCID:", error);
      return res.status(500).json({
        status: 500,
        message: "Server error",
        error: error.message,
      });
    }
  },

  // Check which CCIDs already exist — used for overwrite confirmation before bulk upload
  checkDuplicates: async (req, res) => {
    try {
      const { ccids } = req.body;
      if (!Array.isArray(ccids) || ccids.length === 0) {
        return res.status(400).json({ status: 400, message: "Invalid CCIDs provided" });
      }
      const existing = await EsimMaster.find({ ccid: { $in: ccids } })
        .select("ccid")
        .lean();
      const existingCcids = existing.map((r) => r.ccid);
      return res.status(200).json({
        status: 200,
        total: ccids.length,
        duplicateCount: existingCcids.length,
        newCount: ccids.length - existingCcids.length,
        duplicates: existingCcids,
      });
    } catch (error) {
      console.error("Error in ESIM Master checkDuplicates:", error);
      return res.status(500).json({
        status: 500,
        message: "Server error",
        error: error.message,
      });
    }
  },

  getByCcid: async (req, res) => {
    const startedAt = Date.now();
    let masterLookupMs = 0;
    let refLookupMs = 0;

    try {
      const { ccid } = req.params;
      const masterStartedAt = Date.now();
      const result = await EsimMaster.findOne({ ccid: ccid.trim() }).lean();
      masterLookupMs = Date.now() - masterStartedAt;

      if (!result) {
        logEsimCcidTimings(
          { totalMs: Date.now() - startedAt, masterLookupMs, outcome: "not_found" },
          { ccid: ccid.trim() },
        );
        return res.status(404).json({ status: 404, message: "ESIM Master not found for this CCID" });
      }

      await attachCanonicalApnNames([result]);

      const refLookupStartedAt = Date.now();
      const [makeData, p1Data, p2Data] = await Promise.all([
        EsimMake.findOne({ name: result.esimMake }).lean(),
        EsimProfile.findOne({ name: { $in: [result.profile1] } }).lean(),
        EsimProfile.findOne({ name: { $in: [result.profile2] } }).lean(),
      ]);
      refLookupMs = Date.now() - refLookupStartedAt;

      const finalData = { ...result };
      finalData.esimMakeId = makeData ? makeData.simId : result.esimMake;
      finalData.profile1Id = p1Data ? p1Data.profileId : result.profile1;
      finalData.profile2Id = p2Data ? p2Data.profileId : result.profile2;

      logEsimCcidTimings(
        {
          totalMs: Date.now() - startedAt,
          masterLookupMs,
          refLookupMs,
          outcome: "success",
        },
        { ccid: ccid.trim() },
      );

      return res.status(200).json({
        status: 200,
        message: "ESIM Master record fetched successfully",
        data: finalData,
      });
    } catch (error) {
      logEsimCcidTimings(
        {
          totalMs: Date.now() - startedAt,
          masterLookupMs,
          refLookupMs,
          outcome: "error",
        },
        { ccid: req.params?.ccid },
      );
      console.error("Error in ESIM Master getByCcid:", error);
      return res.status(500).json({
        status: 500,
        message: "Server error",
        error: error.message,
      });
    }
  },

  getAPNByMakeAndProfile: async (req, res) => {
    try {
      const { esimMake, profile1 } = req.params;
      const result = await EsimApn.findOne({ esimMake: esimMake.trim(), esimProfile1: profile1.trim() }).lean();
      if (!result) {
        return res.status(404).json({ status: 404, message: "ESIM Master APN not found for this make and profile" });
      }
      return res.status(200).json({
        status: 200,
        message: "ESIM MasterAPN record fetched successfully",
        data: result,
      });
    } catch (error) {
      console.error("Error in APN getAPNByMakeAndProfile:", error);
      return res.status(500).json({
        status: 500,
        message: "Server error",
        error: error.message,
      });
    }
  },
};