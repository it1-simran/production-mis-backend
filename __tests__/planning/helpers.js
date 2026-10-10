// Fixture builders shared by the planning tests.

const { summarizePlan } = require("../../services/planning/planSummary");
const { normalizeDraft } = require("../../services/planning/draft");
const { buildHolidayKeys } = require("../../utils/planDates");

const DAY_SHIFT = {
  _id: "shift-day",
  name: "Day",
  startTime: "09:00",
  endTime: "18:00",
  weekDays: { sun: false, mon: true, tue: true, wed: true, thu: true, fri: true, sat: false },
  intervals: [
    { startTime: "09:00", endTime: "13:00", breakTime: false },
    { startTime: "13:00", endTime: "14:00", breakTime: true },
    { startTime: "14:00", endTime: "18:00", breakTime: false },
  ],
};

const NIGHT_SHIFT = {
  _id: "shift-night",
  name: "Night",
  startTime: "21:00",
  endTime: "05:00",
  weekDays: { sun: true, mon: true, tue: true, wed: true, thu: true, fri: true, sat: true },
  intervals: [{ startTime: "21:00", endTime: "05:00", breakTime: false }],
};

const PROCESS = {
  _id: "proc-1",
  name: "AIS140",
  status: "waiting_schedule",
  quantity: "1000",
  stages: [
    { stageName: "Visual Inspection", upha: "50", requiredSkill: "Visual Inspection", managedBy: "Operator", hasJigStepType: false },
    { stageName: "Functional", upha: "40", requiredSkill: "Functional", managedBy: "Operator", hasJigStepType: true },
  ],
  commonStages: [],
};

const ROOM = {
  _id: "room-1",
  floorName: "Production Floor",
  lines: [{ rowName: "Line 01", seats: [{}, {}, {}, {}] }, { rowName: "Line 02", seats: [{}, {}, {}, {}] }],
};

const user = (id, extra = {}) => ({
  _id: id,
  name: `User ${id}`,
  userType: "Operator",
  skills: ["Visual Inspection", "Functional"],
  status: "Active",
  ...extra,
});

const stageEntry = (name, upha) => ({ name, stageName: name, upha: String(upha), requiredSkill: name, managedBy: "Operator", hasJigStepType: false });

// A valid single-seat-per-stage draft.
const makeDraft = (overrides = {}) =>
  normalizeDraft({
    selectedProcess: "proc-1",
    selectedRoom: "room-1",
    selectedShift: "shift-day",
    startDate: "05/10/26 00:00:00", // Monday
    repeatCount: 1,
    isDrafted: 0,
    assignedStages: {
      "0-0": [stageEntry("Visual Inspection", 50)],
      "0-1": [stageEntry("Functional", 40)],
    },
    assignedOperators: {},
    assignedJigs: {},
    assignedCustomStagesOp: [],
    ...overrides,
  });

const makeCtx = (overrides = {}) => ({
  process: PROCESS,
  room: ROOM,
  shift: DAY_SHIFT,
  holidayKeys: buildHolidayKeys([]),
  existingPlan: null,
  otherPlans: [],
  overrunPlans: [],
  samePlanForProcess: null,
  users: new Map(),
  jigs: new Map(),
  operatorRows: new Map(),
  jigRows: new Map(),
  truncated: false,
  ...overrides,
});

// An existing plan summary, for conflict tests. `seats` maps seatKey -> stage name.
const otherPlan = ({ id = "plan-x", room = "room-1", shiftTimes = ["09:00", "18:00"], start = "05/10/26", end = "09/10/26", seats = { "0-0": "Visual Inspection" }, operators = {}, jigs = {}, processName = "Other Process", processStatus = "active" } = {}) =>
  summarizePlan(
    {
      _id: id,
      selectedProcess: `proc-${id}`,
      selectedRoom: room,
      selectedShift: "shift-day",
      processName,
      isDrafted: 0,
      startDate: `${start} 00:00:00`,
      estimatedEndDate: `${end} 00:00:00`,
      ProcessShiftMappings: { startTime: shiftTimes[0], endTime: shiftTimes[1] },
      assignedStages: JSON.stringify(Object.fromEntries(Object.entries(seats).map(([k, n]) => [k, [stageEntry(n, 50)]]))),
      assignedOperators: JSON.stringify(operators),
      assignedJigs: JSON.stringify(jigs),
      assignedCustomStagesOp: "[]",
    },
    { processStatus },
  );

const codes = (result) => result.issues.map((i) => i.code);

module.exports = { DAY_SHIFT, NIGHT_SHIFT, PROCESS, ROOM, user, stageEntry, makeDraft, makeCtx, otherPlan, codes };
