// Firebase web app settings (used by account.js). Not secret: every Firebase
// web app ships them to the browser; data is protected by firestore.rules.
// Project: edit1-jobs-6f37bc (Firestore in eur3). No measurementId: no analytics.
window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDsXrS5U-zxA7kW5vZsixeybBf8HKFPxGA',
  authDomain: 'edit1-jobs-6f37bc.firebaseapp.com',
  projectId: 'edit1-jobs-6f37bc',
  storageBucket: 'edit1-jobs-6f37bc.firebasestorage.app',
  messagingSenderId: '255253263372',
  appId: '1:255253263372:web:543f231296af4962f72a29',
};

// "Report issue" on the test stages' banner (report.js, issue #27; playbook
// report-issue.md). Needs the issueReports rules, access/testers and the
// GitHub secrets.
window.REPORT_ISSUES = true;
