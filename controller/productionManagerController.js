const mongoose = require("mongoose");
const ProcessModel = require("../models/process");
const PlaningAndSchedulingModel = require("../models/planingAndSchedulingModel");
const DeviceTestModel = require("../models/deviceTestModel");
const RoomPlanModel = require("../models/roomPlan");
const moment = require("moment-timezone");
module.exports = {
  getProcesses: async (req, res) => {
    try {
      let Processes = await ProcessModel.aggregate([
        // { $match: {status: "Waiting_Kits_approval"}},
        {
          $lookup: {
            from: "planingandschedulings",
            localField: "_id",
            foreignField: "selectedProcess",
            as: "planingDetails",
          },
        },
        {
          $unwind: {
            path: "$planingDetails",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: "products",
            localField: "selectedProduct",
            foreignField: "_id",
            as: "productDetails",
          },
        },
        { $unwind: "$productDetails" },
        {
          $lookup: {
            from: "assignkitstolines",
            localField: "_id",
            foreignField: "processId",
            as: "assignKitsToLine",
          },
        },
        {
          $unwind: {
            path: "$assignKitsToLine",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            _id: 1,
            name: 1,
            selectedProduct: 1,
            orderConfirmationNo: 1,
            processID: 1,
            quantity: 1,
            issuedKits: 1,
            issuedCartons: 1,
            consumedKits: 1,
            consumedCartons: 1,
            descripition: 1,
            fgToStore: 1,
            stages: 1,
            dispatchStatus: 1,
            deliverStatus: 1,
            kitStatus: 1,
            status: 1,
            createdAt: 1,
            updatedAt: 1,
            planId: "$planingDetails._id",
            issuedKitsToOperator: "$assignKitsToLine.issuedKits",
            assignStages: "$planingDetails.assignedStages",
            repeatCount: "$planingDetails.repeatCount",
            productStage: "$productDetails.stages",
            kitRecievedId: "$assignKitsToLine._id",
            kitRecievedConfirmationStatus: "$assignKitsToLine.status",
            issuedKitsStatus: "$assignKitsToLine.issuedKitsStatus",
            assignedKitsToOperator: "$assignKitsToLine.issuedKits",
          },
        },
      ]);

      return res.status(200).json({
        status: 200,
        message: "Processes Fetched Successfully!!",
        Processes,
      });
    } catch (error) {
      res
        .status(500)
        .json({
          message: `An error occurred while Fetching the Prodcesss:${error.message}`,
        });
    }
  },
  getRemainingKitFromCompletedProcess: async (req, res) => {
    try {
      let Processes = await ProcessModel.aggregate([
        { $match: { status: "completed" } },
        {
          $lookup: {
            from: "returnkittostores",
            localField: "_id",
            foreignField: "processId",
            as: "returnKitsDetails",
          },
        },
        {
          $unwind: {
            path: "$returnKitsDetails",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            consumedCartons: 1,
            consumedKits: 1,
            createdAt: 1,
            deliverStatus: 1,
            descripition: 1,
            dispatchStatus: 1,
            fgToStore: 1,
            issuedCartons: 1,
            issuedKits: 1,
            kitStatus: 1,
            name: 1,
            orderConfirmationNo: 1,
            processID: 1,
            quantity: 1,
            returnKitsStatus: { $ifNull: ["$returnKitsDetails.status", ""] },
            selectedProduct: 1,
            status: 1,
            updatedAt: 1,
          },
        },
      ]);
      return res.status(200).json({
        status: 200,
        message: "Processes Fetched Successfully!!",
        Processes,
      });
    } catch (error) {
      res
        .status(500)
        .json({
          message: "An error occurred while Fetching the Remaining Kit ",
        });
    }
  },
  updateProductionStatus: async (req, res) => {
    try {
      const { id: ProcessId, status: ProductionStatus, issuedKits } = req.body;

      const existingProcess = await ProcessModel.findById(ProcessId);

      if (!existingProcess) {
        return res.status(404).json({
          status: 404,
          message: "Process not found",
        });
      }

      const updateData = {
        status: ProductionStatus,
      };

      if (existingProcess.kitStatus === "Waiting_Kits_allocation") {
        updateData.issuedKits = issuedKits;
      }

      const Process = await ProcessModel.findByIdAndUpdate(
        ProcessId,
        updateData,
        { new: true }
      );

      return res.status(200).json({
        status: 200,
        message: "Update Production Status Successfully!!",
        Process,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        message: "An error occurred while updating the Production status",
      });
    }
  },

  processStatics: async (req, res) => {
    try {
      let Process = await ProcessModel.aggregate([
        {
          $lookup: {
            from: "planingandschedulings",
            localField: "_id",
            foreignField: "selectedProcess",
            as: "planingData",
          },
        },
        { $unwind: "$planingData" },
        // {
        //   $project: {
        //     // _id: 1,
        //     // name: 1,
        //     // processID: 1,
        //     // processQuantity: "$quantity",
        //     // inventoryQuantity: "$inventoryProcess.quantity",
        //     // cartonQuantity: "$inventoryProcess.cartonQuantity",
        //     // status: "$inventoryProcess.status",
        //     // productName: "$products.name",
        //     // issuedKits: 1,
        //     // issuedCartons: 1,
        //     // createdAt: 1,
        //     // updatedAt: 1,
        //     // status: 1,
        //     // productDetails: 1,
        //   },
        // },
      ]);

    } catch (error) {
      res
        .status(500)
        .json({
          message: "An error occured while updating the Production Status",
        });
    }
  },
  getProcessCompletionAnalytics: async (req, res) => {
    try {
      const days = Math.max(parseInt(req.query.days, 10) || 14, 1);
      const start = new Date();
      start.setDate(start.getDate() - (days - 1));
      start.setHours(0, 0, 0, 0);

      const daily = await ProcessModel.aggregate([
        { $match: { createdAt: { $gte: start } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            total: { $sum: 1 },
            completed: {
              $sum: {
                $cond: [{ $eq: ["$status", "completed"] }, 1, 0],
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      const map = daily.reduce((acc, row) => {
        acc[row._id] = row;
        return acc;
      }, {});

      const categories = [];
      const completionRate = [];
      for (let i = 0; i < days; i += 1) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const key = d.toISOString().slice(0, 10);
        categories.push(key);
        const row = map[key];
        const rate = row && row.total > 0 ? (row.completed / row.total) * 100 : 0;
        completionRate.push(Number(rate.toFixed(2)));
      }

      const totals = await ProcessModel.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
            },
          },
        },
      ]);
      const total = totals[0]?.total || 0;
      const completed = totals[0]?.completed || 0;
      const overallRate = total > 0 ? (completed / total) * 100 : 0;

      return res.status(200).json({
        status: 200,
        message: "Process completion analytics fetched successfully",
        categories,
        series: [{ name: "Completion Rate (%)", data: completionRate }],
        overall: {
          total,
          completed,
          rate: Number(overallRate.toFixed(2)),
        },
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "An error occurred while fetching completion analytics",
        error: error.message,
      });
    }
  },
  getMesProductionDashboard: async (req, res) => {
    try {
      const { processId, timezone } = req.query || {};
      const tz = timezone || "UTC";

      const startMoment = moment.tz(tz).startOf("day");
      const endMoment = moment.tz(tz).endOf("day");

      const startDate = startMoment.toDate();
      const endDate = endMoment.toDate();
      const startMs = startDate.getTime();
      const endMs = endDate.getTime();

      let plans = await PlaningAndSchedulingModel.find({}).lean();

      const planInRange = (p) => {
        const s = p?.startDate ? new Date(p.startDate).getTime() : null;
        const e = p?.estimatedEndDate ? new Date(p.estimatedEndDate).getTime() : s;
        if (!s && !e) return false;
        return (s || 0) <= endMs && (e || s || 0) >= startMs;
      };
      plans = plans.filter((p) => planInRange(p));
      if (processId) {
        plans = plans.filter((p) => String(p?.selectedProcess || "") === String(processId));
      }

      const processesAll = await ProcessModel.find({ status: "active" }).lean();
      let processes = processesAll;

      const processIds = [
        ...new Set(plans.map((p) => String(p?.selectedProcess || "")).filter(Boolean)),
      ];
      processes = processesAll.filter((p) => processIds.includes(String(p._id)));

      const processMap = processes.reduce((acc, p) => {
        acc[String(p._id)] = p;
        return acc;
      }, {});

      const deviceTests = await DeviceTestModel.find({
        processId: { $in: processIds },
        createdAt: { $gte: startDate, $lte: endDate },
      }).lean();

      const latestMap = new Map();
      deviceTests.forEach((record) => {
        const stageName = String(record?.stageName || "").trim();
        if (!stageName) return;
        const planKey = record?.planId ? String(record.planId) : "";
        const deviceKey = record?.deviceId
          ? String(record.deviceId)
          : (record?.serialNo ? String(record.serialNo) : String(record._id));
        if (!deviceKey) return;
        const key = `${planKey}||${stageName}||${deviceKey}`;
        const existing = latestMap.get(key);
        if (!existing || new Date(record.createdAt) > new Date(existing.createdAt)) {
          latestMap.set(key, record);
        }
      });
      const latestRecords = Array.from(latestMap.values());

      const seatStats = {};
      latestRecords.forEach((r) => {
        const seat = String(r?.seatNumber || "").trim();
        if (!seat) return;
        if (!seatStats[seat]) seatStats[seat] = { pass: 0, ng: 0 };
        const status = String(r?.status || "").toUpperCase();
        if (status === "PASS" || status === "COMPLETED") seatStats[seat].pass += 1;
        if (status === "NG" || status === "FAIL") seatStats[seat].ng += 1;
      });

      const seatsMap = new Map();
      plans.forEach((p) => {
        let assigned = p?.assignedStages || "{}";
        if (typeof assigned === "string") {
          try {
            assigned = JSON.parse(assigned || "{}");
          } catch (e) {
            assigned = {};
          }
        }
        Object.keys(assigned || {}).forEach((seatKey) => {
          if (seatsMap.has(seatKey)) return;
          const stages = Array.isArray(assigned[seatKey]) ? assigned[seatKey] : [assigned[seatKey]];
          const stage = stages[0] || {};
          const parts = String(seatKey).split("-");
          const rowNo = parts[0] || "";
          const seatNo = parts.length > 1 ? parts[1] : seatKey;
          const matchStats = seatStats[seatKey] || seatStats[seatNo] || { pass: 0, ng: 0 };
          seatsMap.set(seatKey, {
            seatKey,
            rowNo,
            seatNo,
            stageName: stage?.name || stage?.stageName || "",
            pass: matchStats.pass || 0,
            ng: matchStats.ng || 0,
            wipKits: Number(stage?.totalUPHA || 0) || 0,
            totalUPHA: Number(stage?.upha || 0) || 0,
          });
        });
      });
      const seats = Array.from(seatsMap.values());
      const stageStats = {};
      latestRecords.forEach((r) => {
        const stage = String(r?.stageName || "Unknown").trim() || "Unknown";
        if (!stageStats[stage]) stageStats[stage] = { pass: 0, ng: 0, total: 0 };
        const status = String(r?.status || "").toUpperCase();
        stageStats[stage].total += 1;
        if (status === "PASS" || status === "COMPLETED") stageStats[stage].pass += 1;
        if (status === "NG" || status === "FAIL") stageStats[stage].ng += 1;
      });

      const stageTargets = {};
      processes.forEach((p) => {
        const qty = Number(p?.quantity || 0) || 0;
        (p?.stages || []).forEach((s) => {
          const name = String(s?.stageName || "Unknown").trim() || "Unknown";
          stageTargets[name] = (stageTargets[name] || 0) + qty;
        });
      });

      let ordersDueToday = 0;
      let backlogDueToday = 0;
      let completedToday = 0;

      plans.forEach((p) => {
        const due = p?.estimatedEndDate ? new Date(p.estimatedEndDate).getTime() : null;
        const start = p?.startDate ? new Date(p.startDate).getTime() : null;
        const status = String(p?.status || "").toLowerCase();
        if (due && due >= startMs && due <= endMs) {
          ordersDueToday += 1;
          if (status !== "completed") backlogDueToday += 1;
        }
        if (
          status === "completed" &&
          ((due && due >= startMs && due <= endMs) || (start && start >= startMs && start <= endMs))
        ) {
          completedToday += 1;
        }
      });

      let totalDowntimeSeconds = 0;
      const downtimeByStage = {};

      const computeOverlapSeconds = (from, to) => {
        if (!from || !to) return 0;
        const a = Math.max(new Date(from).getTime(), startMs);
        const b = Math.min(new Date(to).getTime(), endMs);
        return b > a ? Math.floor((b - a) / 1000) : 0;
      };

      plans.forEach((p) => {
        const dt = p?.downTime || {};
        const from = dt?.from || dt?.downTimeFrom || dt?.downTimefrom;
        let to = dt?.to || dt?.downTimeTo || dt?.downTimeToDate;
        if (!to && String(p?.status || "").toLowerCase() === "down_time_hold") {
          to = endDate;
        }
        const overlap = computeOverlapSeconds(from, to);
        if (overlap <= 0) return;
        totalDowntimeSeconds += overlap;

        const proc = processMap[String(p?.selectedProcess || "")];
        const stages = proc?.stages || [];
        const stageCount = stages.length || 0;
        if (stageCount > 0) {
          const perStage = Math.floor(overlap / stageCount);
          stages.forEach((s) => {
            const name = String(s?.stageName || "Unknown").trim() || "Unknown";
            downtimeByStage[name] = (downtimeByStage[name] || 0) + perStage;
          });
        }
      });

      const stageOrder = [];
      processes.forEach((p) => {
        (p?.stages || []).forEach((s) => {
          const name = String(s?.stageName || "Unknown").trim() || "Unknown";
          if (name && !stageOrder.includes(name)) stageOrder.push(name);
        });
      });

      const stageNames = Array.from(
        new Set([...stageOrder, ...Object.keys(stageTargets), ...Object.keys(stageStats)])
      );

      const capCounts = (pass, ng, cap) => {
        const p = pass || 0;
        const n = ng || 0;
        const c = cap || 0;
        if (!c || c <= 0) return { pass: p, ng: n };
        const total = p + n;
        if (total <= c) return { pass: p, ng: n };
        const cappedPass = Math.min(p, c);
        const remaining = Math.max(c - cappedPass, 0);
        const cappedNg = Math.min(n, remaining);
        return { pass: cappedPass, ng: cappedNg };
      };

      const cells = stageNames.map((name) => {
        const target = stageTargets[name] || 0;
        const capped = capCounts(stageStats[name]?.pass || 0, stageStats[name]?.ng || 0, target);
        return {
          cellId: name.toLowerCase().replace(/\s+/g, "-"),
          name,
          complete: capped.pass,
          target,
          defects: capped.ng,
        };
      });

      const cellLoading = stageNames.map((name) => ({
        cellId: name.toLowerCase().replace(/\s+/g, "-"),
        name,
        qtyRequired: stageTargets[name] || 0,
      }));

      const downtimeByCell = stageNames.map((name) => ({
        cellId: name.toLowerCase().replace(/\s+/g, "-"),
        name,
        downtimeSeconds: downtimeByStage[name] || 0,
      }));

      const ordersByStatusMap = {};
      plans.forEach((p) => {
        const status = String(p?.status || "unknown");
        ordersByStatusMap[status] = (ordersByStatusMap[status] || 0) + 1;
      });
      const ordersByStatus = Object.keys(ordersByStatusMap).map((status) => ({
        status,
        count: ordersByStatusMap[status],
      }));

      const processesList = processesAll.map((p) => ({
        _id: p._id,
        name: p.name,
        processID: p.processID,
      }));
      const workInProgress = stageNames.map((name) => {
        const target = stageTargets[name] || 0;
        const capped = capCounts(stageStats[name]?.pass || 0, stageStats[name]?.ng || 0, target);
        const done = capped.pass + capped.ng;
        return {
          itemId: name.toLowerCase().replace(/\s+/g, "-"),
          name,
          qty: Math.max(target - done, 0),
        };
      });

      return res.status(200).json({
        status: 200,
        message: "MES production dashboard fetched successfully",
        kpis: {
          ordersDueToday,
          backlogDueToday,
          completedToday,
          totalDowntimeSeconds,
        },
        processes: processesList,
        seats,
        cells,
        charts: {
          cellLoading,
          downtimeByCell,
          ordersByStatus,
          workInProgress,
        },
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      return res.status(500).json({
        status: 500,
        message: "An error occurred while building MES production dashboard",
        error: error.message,
      });
    }
  },
};





























