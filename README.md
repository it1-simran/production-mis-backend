Production MES Backend
Overview

The Production MES Backend is the core service layer of the Manufacturing Execution System (MES). It manages the complete production workflow, device tracking, stage processing, carton management, and system integrations used in the production environment.

This backend provides APIs that support the TRC portal, Operator portal, and Production management modules, ensuring smooth communication between the system components.

The system is designed to track devices across multiple production stages while maintaining full traceability and production history.

System Architecture

The backend follows a REST API based architecture where the server handles:

Production workflow management

Device stage tracking

Carton processing

Product configuration

Barcode and sticker data management

Operator and TRC operations

Frontend applications communicate with the backend through secure API endpoints.

Key Features
1. Product Management

Create and manage products.

Define multiple production stages.

Enable or disable stages.

Save products as draft before publishing.

2. Production Workflow Management

Manage device movement across stages.

Track real-time production status.

Maintain full stage history of each device.

3. Device Tracking

Each device is tracked using a barcode or serial number.

Stage updates are recorded during scanning.

Complete lifecycle of a device is maintained.

4. Carton Management

Assign devices to cartons.

Process full cartons and partial cartons.

Handle carton closing and validation.

5. TRC Operations

TRC users can:

Assign devices to stages

Validate device movement

Monitor device processing

6. Operator Processing

Operators can:

Scan devices

Process production stages

Update carton status

7. Sticker & Barcode Data

Provide sticker data for printing

Generate barcode-related information

Manage product labeling information

Technology Stack

Backend is built using the following technologies:

Runtime

Node.js

Framework

Express.js

Database

MongoDB

Authentication

JWT based authentication

Other Tools

Barcode processing

API-based architecture

Project Structure
production-mes-backend
│
├── controllers        # Business logic
├── routes             # API routes
├── models             # Database schemas
├── middleware         # Authentication and validations
├── services           # Core service logic
├── utils              # Helper functions
├── config             # Database and environment configuration
├── logs               # Application logs
└── server.js          # Application entry point
Installation

Clone the repository:

git clone <repository-url>

Move into the project directory:

cd production-mes-backend

Install dependencies:

npm install
Environment Variables

Create a .env file in the root directory.

Example configuration:

PORT=4000
MONGO_URI=your_mongodb_connection
JWT_SECRET=your_secret_key
NODE_ENV=development
Running the Application
Development Mode
npm run dev
Production Mode
npm run build
npm start
API Modules

The backend provides APIs for the following modules:

Authentication

Product Management

Production Planning

Device Processing

Carton Management

Stage Tracking

TRC Operations

Operator Operations

Sticker & Barcode Data

Production Workflow

High level workflow followed by the MES system:

Product is created with defined production stages.

Production planning assigns devices.

Devices are assigned to cartons.

Operators scan devices at each stage.

Backend updates stage history.

TRC validates the device processing.

Final stage marks production completion.

Logging & Monitoring

The system logs important events including:

Stage processing

Device scanning

Carton operations

System errors

Logs help in debugging and production monitoring.

Deployment

The backend can be deployed on:

AWS EC2

Docker containers

On-premise servers

Process managers like PM2 can be used for production deployment.

Example:

pm2 start ecosystem.config.js
Testing

Before production deployment:

Validate APIs with production scenarios.

Test device scanning workflow.

Verify carton processing.

Confirm stage history tracking.

A dedicated production resource is recommended for validating the real production flow.

Future Enhancements

Production analytics

Real-time device tracking dashboard

Automated reporting

Department performance monitoring

Maintainers
JSD Electronics india pvt ltd
