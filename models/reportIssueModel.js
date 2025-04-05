const mongoose = require("mongoose");


const reportedIssueSchema = new mongoose.Schema({
 serialNo: { type: String,required:true },
 reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: "users" },
 processId : {type: mongoose.Schema.Types.ObjectId, ref: "processes"},
 currentStage:{type:String,required:true},
 issueType:{ type: String, required: true, default: ""},
 issueDescription:{ type: String, required: true, default: ""},

 createdAt: { type: Date, default: Date.now },
 updatedAt: { type: Date, default: Date.now },
});
module.exports = mongoose.model("reportedIssue", reportedIssueSchema);
