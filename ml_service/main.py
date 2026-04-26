"""
MedPlus ML Microservice — FastAPI
Run: uvicorn main:app --reload --port 8000
"""

import random
import math
from datetime import datetime
from typing import List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="MedPlus ML Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Request / Response models ────────────────────────────────────────────────

class ScanRequest(BaseModel):
    scan_type: str         # MRI | CT | X-ray | Ultrasound | ECG
    patient_id: Optional[int] = None
    image_base64: Optional[str] = None   # optional — for future real model

class RiskRequest(BaseModel):
    patient_id: Optional[int] = None
    bp_systolic: Optional[float] = None
    bp_diastolic: Optional[float] = None
    blood_sugar: Optional[float] = None
    weight: Optional[float] = None
    temperature: Optional[float] = None
    age: Optional[int] = None
    smoker: Optional[bool] = False
    family_history: Optional[bool] = False

class AnomalyRequest(BaseModel):
    patient_id: Optional[int] = None
    metrics: List[dict]       # list of {bp_systolic, bp_diastolic, blood_sugar, ...}

class DrugCheckRequest(BaseModel):
    medicines: List[str]

class OcrRequest(BaseModel):
    image_base64: str
    patient_id: Optional[int] = None

# ─── Drug interaction knowledge base ─────────────────────────────────────────

DRUG_CLASS_MAP = {
    "aspirin":                 ["aspirin"],
    "warfarin":                ["warfarin", "coumadin"],
    "ibuprofen":               ["ibuprofen", "advil", "brufen"],
    "naproxen":                ["naproxen", "aleve"],
    "paracetamol":             ["paracetamol", "acetaminophen", "tylenol"],
    "metformin":               ["metformin", "glucophage"],
    "ssri":                    ["fluoxetine", "sertraline", "paroxetine", "escitalopram", "citalopram"],
    "ace inhibitor":           ["lisinopril", "enalapril", "ramipril", "captopril"],
    "statin":                  ["atorvastatin", "simvastatin", "rosuvastatin", "lovastatin"],
    "beta blocker":            ["metoprolol", "atenolol", "propranolol", "bisoprolol"],
    "calcium channel blocker": ["amlodipine", "nifedipine", "diltiazem", "verapamil"],
    "nsaid":                   ["ibuprofen", "naproxen", "diclofenac", "celecoxib", "indomethacin"],
    "amiodarone":              ["amiodarone"],
    "digoxin":                 ["digoxin", "digitalis"],
    "tramadol":                ["tramadol"],
    "erythromycin":            ["erythromycin", "clarithromycin", "azithromycin"],
    "linezolid":               ["linezolid"],
    "methotrexate":            ["methotrexate"],
    "potassium":               ["potassium", "potassium chloride"],
    "alcohol":                 ["alcohol", "ethanol"],
    "nitrate":                 ["nitroglycerin", "isosorbide", "nitrate"],
    "sildenafil":              ["sildenafil", "tadalafil", "viagra", "cialis"],
    "clopidogrel":             ["clopidogrel", "plavix"],
}

INTERACTIONS = [
    {"drugs": ["warfarin", "aspirin"],              "risk": "HIGH",     "message": "Increased bleeding risk — monitor INR closely"},
    {"drugs": ["warfarin", "nsaid"],                "risk": "HIGH",     "message": "NSAIDs increase warfarin effect — serious bleeding risk"},
    {"drugs": ["warfarin", "erythromycin"],         "risk": "HIGH",     "message": "Macrolides inhibit warfarin metabolism — INR spike risk"},
    {"drugs": ["ssri", "tramadol"],                 "risk": "HIGH",     "message": "Risk of serotonin syndrome — potentially life-threatening"},
    {"drugs": ["ssri", "linezolid"],                "risk": "HIGH",     "message": "Serotonin syndrome — contraindicated"},
    {"drugs": ["digoxin", "amiodarone"],            "risk": "HIGH",     "message": "Amiodarone raises digoxin levels — toxicity risk"},
    {"drugs": ["methotrexate", "nsaid"],            "risk": "HIGH",     "message": "NSAIDs reduce methotrexate clearance — serious toxicity"},
    {"drugs": ["sildenafil", "nitrate"],            "risk": "HIGH",     "message": "Severe hypotension — contraindicated"},
    {"drugs": ["clopidogrel", "aspirin"],           "risk": "MODERATE", "message": "Dual antiplatelet therapy increases bleeding risk"},
    {"drugs": ["ace inhibitor", "potassium"],       "risk": "MODERATE", "message": "Hyperkalemia risk — monitor potassium"},
    {"drugs": ["ace inhibitor", "nsaid"],           "risk": "MODERATE", "message": "Reduced antihypertensive effect; nephrotoxicity risk"},
    {"drugs": ["statin", "amiodarone"],             "risk": "MODERATE", "message": "Increased myopathy / rhabdomyolysis risk"},
    {"drugs": ["statin", "erythromycin"],           "risk": "MODERATE", "message": "Macrolides raise statin levels — myopathy risk"},
    {"drugs": ["beta blocker", "calcium channel blocker"], "risk": "MODERATE", "message": "May cause bradycardia or heart block"},
    {"drugs": ["paracetamol", "alcohol"],           "risk": "MODERATE", "message": "Hepatotoxicity risk with excessive alcohol"},
    {"drugs": ["metformin", "alcohol"],             "risk": "MODERATE", "message": "Increased lactic acidosis risk"},
    {"drugs": ["aspirin", "ibuprofen"],             "risk": "LOW",      "message": "Ibuprofen may reduce aspirin's cardioprotective effect"},
]

# ─── Scan templates ───────────────────────────────────────────────────────────

SCAN_TEMPLATES = {
    "MRI": [
        {"anomaly": False, "confidence": 0.91, "findings": "No significant intracranial abnormality. Brain parenchyma appears normal with age-appropriate volume."},
        {"anomaly": True,  "confidence": 0.78, "findings": "T2 hyperintense lesion in right temporal lobe (~8 mm). Recommend clinical correlation and follow-up MRI."},
        {"anomaly": True,  "confidence": 0.83, "findings": "Periventricular white matter changes consistent with small vessel ischaemic disease."},
    ],
    "CT": [
        {"anomaly": False, "confidence": 0.93, "findings": "No acute intracranial haemorrhage, mass effect, or midline shift. Normal CT study."},
        {"anomaly": True,  "confidence": 0.74, "findings": "Hypodense area in right basal ganglia suggesting lacunar infarct. Neurology referral advised."},
        {"anomaly": True,  "confidence": 0.86, "findings": "Mild diffuse cerebral volume loss consistent with age-related atrophy."},
    ],
    "X-ray": [
        {"anomaly": False, "confidence": 0.95, "findings": "Clear lung fields bilaterally. Normal cardiac silhouette. No bony abnormality detected."},
        {"anomaly": True,  "confidence": 0.80, "findings": "Increased bronchovascular markings — suggestive of early bronchitis or mild congestion."},
        {"anomaly": True,  "confidence": 0.82, "findings": "Cardiomegaly: cardiac silhouette enlarged (CTR > 0.5). Echo recommended."},
    ],
    "Ultrasound": [
        {"anomaly": False, "confidence": 0.90, "findings": "Normal abdominal ultrasound. Liver, kidneys, spleen, pancreas within normal limits."},
        {"anomaly": True,  "confidence": 0.77, "findings": "Mild hepatomegaly — liver measures 15.8 cm. Liver function tests recommended."},
        {"anomaly": True,  "confidence": 0.94, "findings": "Cholelithiasis: 3 calculi in gallbladder averaging 9 mm. Surgical consult advised."},
    ],
    "ECG": [
        {"anomaly": False, "confidence": 0.96, "findings": "Normal sinus rhythm, 74 bpm. No ST-T changes or conduction abnormalities."},
        {"anomaly": True,  "confidence": 0.97, "findings": "Sinus tachycardia, 112 bpm. No acute ischaemic changes. Investigate underlying cause."},
        {"anomaly": True,  "confidence": 0.81, "findings": "Left ventricular hypertrophy pattern with repolarisation changes. Cardiology review recommended."},
    ],
}

# ─── Helper functions ─────────────────────────────────────────────────────────

def resolve_drug_classes(medicine_names: List[str]) -> set:
    classes = set()
    for med in medicine_names:
        low = med.lower().strip()
        classes.add(low)
        for cls, drugs in DRUG_CLASS_MAP.items():
            if any(low in d or d in low for d in drugs):
                classes.add(cls)
    return classes


def run_drug_check(medicines: List[str]) -> dict:
    classes = resolve_drug_classes(medicines)
    warnings = []
    seen = set()

    for interaction in INTERACTIONS:
        d1, d2 = interaction["drugs"]
        hit1 = any(d1 in c or c in d1 for c in classes)
        hit2 = any(d2 in c or c in d2 for c in classes)
        key  = frozenset([d1, d2])
        if hit1 and hit2 and key not in seen:
            seen.add(key)
            warnings.append({
                "drugs":   interaction["drugs"],
                "risk":    interaction["risk"],
                "message": interaction["message"],
            })

    risk_level = (
        "HIGH"     if any(w["risk"] == "HIGH"     for w in warnings) else
        "MODERATE" if any(w["risk"] == "MODERATE" for w in warnings) else
        "SAFE"
    )

    recommendation = {
        "HIGH":     "Prescription flagged — pharmacist review required before dispensing",
        "MODERATE": "Minor interactions found — monitor patient closely",
        "SAFE":     "No significant drug interactions detected",
    }[risk_level]

    return {
        "riskLevel":      risk_level,
        "warnings":       warnings,
        "recommendation": recommendation,
        "checkedAt":      datetime.utcnow().isoformat() + "Z",
        "model":          "MedPlus Drug Interaction Engine v1.0",
    }


def run_risk_prediction(data: RiskRequest) -> List[dict]:
    results = []

    # Cardiovascular
    cv = 0
    if data.bp_systolic:
        if data.bp_systolic > 140: cv += 30
        elif data.bp_systolic > 130: cv += 18
        elif data.bp_systolic > 120: cv += 8
    if data.bp_diastolic:
        if data.bp_diastolic > 90: cv += 22
        elif data.bp_diastolic > 80: cv += 8
    if data.blood_sugar and data.blood_sugar > 200: cv += 20
    elif data.blood_sugar and data.blood_sugar > 125: cv += 12
    if data.age and data.age > 55: cv += 10
    if data.smoker: cv += 15
    if data.family_history: cv += 10
    cv = min(cv, 100)
    results.append({"condition": "Cardiovascular Disease", "score": cv,
                     "level": "HIGH" if cv >= 50 else "MODERATE" if cv >= 25 else "LOW"})

    # Diabetes
    db = 0
    if data.blood_sugar:
        if data.blood_sugar > 200: db += 65
        elif data.blood_sugar > 125: db += 45
        elif data.blood_sugar > 100: db += 20
    if data.weight:
        if data.weight > 95: db += 18
        elif data.weight > 80: db += 9
    if data.family_history: db += 10
    if data.age and data.age > 45: db += 8
    db = min(db, 100)
    results.append({"condition": "Type 2 Diabetes", "score": db,
                     "level": "HIGH" if db >= 50 else "MODERATE" if db >= 25 else "LOW"})

    # Hypertension
    ht = 0
    if data.bp_systolic:
        if data.bp_systolic > 140: ht += 70
        elif data.bp_systolic > 130: ht += 45
        elif data.bp_systolic > 120: ht += 20
    if data.bp_diastolic:
        if data.bp_diastolic > 90: ht += 30
        elif data.bp_diastolic > 80: ht += 12
    if data.smoker: ht += 10
    if data.age and data.age > 50: ht += 8
    ht = min(ht, 100)
    results.append({"condition": "Hypertension", "score": ht,
                     "level": "HIGH" if ht >= 50 else "MODERATE" if ht >= 25 else "LOW"})

    # Obesity
    ob = 0
    if data.weight:
        if data.weight > 100: ob = 85
        elif data.weight > 90:  ob = 65
        elif data.weight > 80:  ob = 40
        elif data.weight > 70:  ob = 20
    ob = min(ob, 100)
    results.append({"condition": "Obesity Risk", "score": ob,
                     "level": "HIGH" if ob >= 60 else "MODERATE" if ob >= 30 else "LOW"})

    return results


def detect_anomalies(metrics: List[dict]) -> List[dict]:
    alerts = []
    if not metrics:
        return alerts

    def mean(vals): return sum(vals) / len(vals) if vals else 0
    def std(vals):
        if len(vals) < 2: return 0
        m = mean(vals)
        return math.sqrt(sum((v - m) ** 2 for v in vals) / len(vals))

    for field, label, normal_min, normal_max in [
        ("bp_systolic",  "Systolic BP",    90,  140),
        ("bp_diastolic", "Diastolic BP",   60,  90),
        ("blood_sugar",  "Blood Sugar",    70,  125),
        ("temperature",  "Temperature",    36.1, 37.5),
    ]:
        vals = [m[field] for m in metrics if m.get(field) is not None]
        if not vals:
            continue

        m = mean(vals)
        s = std(vals)
        latest = vals[-1]

        # Spike alert: latest value outside normal range
        if latest > normal_max:
            severity = "HIGH" if latest > normal_max * 1.15 else "MODERATE"
            alerts.append({
                "metric":   label,
                "value":    latest,
                "type":     "elevated",
                "severity": severity,
                "message":  f"{label} reading of {latest} is above normal (>{normal_max})",
            })
        elif latest < normal_min:
            alerts.append({
                "metric":   label,
                "value":    latest,
                "type":     "low",
                "severity": "MODERATE",
                "message":  f"{label} reading of {latest} is below normal (<{normal_min})",
            })

        # Statistical spike: more than 2 std from mean
        if s > 0 and abs(latest - m) > 2 * s:
            alerts.append({
                "metric":   label,
                "value":    latest,
                "type":     "statistical_spike",
                "severity": "LOW",
                "message":  f"{label} shows unusual spike vs recent trend (mean={round(m,1)}, σ={round(s,1)})",
            })

    return alerts


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"service": "MedPlus ML Microservice", "version": "1.0.0", "status": "running"}


@app.post("/predict-scan")
def predict_scan(req: ScanRequest):
    scan_type = req.scan_type if req.scan_type in SCAN_TEMPLATES else "X-ray"
    templates = SCAN_TEMPLATES[scan_type]
    t = templates[random.randint(0, len(templates) - 1)]
    return {
        "scanType":       scan_type,
        "anomalyDetected": t["anomaly"],
        "confidenceScore": round(t["confidence"] + random.uniform(-0.04, 0.04), 2),
        "findings":        t["findings"],
        "recommendation": (
            "Recommend clinical correlation and possible follow-up imaging."
            if t["anomaly"] else
            "No immediate follow-up required. Routine monitoring advised."
        ),
        "analyzedAt": datetime.utcnow().isoformat() + "Z",
        "model": "MedPlus Scan AI v1.0",
    }


@app.post("/predict-risk")
def predict_risk(req: RiskRequest):
    risks = run_risk_prediction(req)
    overall = (
        "HIGH"     if any(r["level"] == "HIGH"     for r in risks) else
        "MODERATE" if any(r["level"] == "MODERATE" for r in risks) else
        "LOW"
    )
    return {
        "risks":       risks,
        "overallRisk": overall,
        "analyzedAt":  datetime.utcnow().isoformat() + "Z",
        "model":       "MedPlus Risk Predictor v1.0",
    }


@app.post("/anomaly-detect")
def anomaly_detect(req: AnomalyRequest):
    alerts = detect_anomalies(req.metrics)
    return {
        "patientId": req.patient_id,
        "alerts":    alerts,
        "hasAlerts": len(alerts) > 0,
        "severity":  (
            "HIGH"     if any(a["severity"] == "HIGH"     for a in alerts) else
            "MODERATE" if any(a["severity"] == "MODERATE" for a in alerts) else
            "LOW"      if alerts else
            "NONE"
        ),
        "analyzedAt": datetime.utcnow().isoformat() + "Z",
        "model": "MedPlus Anomaly Detector v1.0",
    }


@app.post("/drug-interaction-check")
def drug_interaction_check(req: DrugCheckRequest):
    return run_drug_check(req.medicines)


@app.post("/ocr-prescription")
def ocr_prescription(req: OcrRequest):
    """
    Mock OCR endpoint. In production this would use Tesseract / Google Vision API.
    Returns a plausible set of extracted medicines for demo purposes.
    """
    DEMO_EXTRACTIONS = [
        [
            {"name": "Paracetamol",  "dosage": "500mg",  "frequency": "twice daily",        "duration": "5 days"},
            {"name": "Amoxicillin",  "dosage": "250mg",  "frequency": "three times daily",  "duration": "7 days"},
        ],
        [
            {"name": "Metformin",    "dosage": "500mg",  "frequency": "twice daily",         "duration": "30 days"},
            {"name": "Atorvastatin", "dosage": "10mg",   "frequency": "once daily at night", "duration": "90 days"},
        ],
        [
            {"name": "Ibuprofen",    "dosage": "400mg",  "frequency": "three times daily",   "duration": "3 days"},
            {"name": "Omeprazole",   "dosage": "20mg",   "frequency": "once daily",           "duration": "7 days"},
        ],
        [
            {"name": "Amlodipine",   "dosage": "5mg",    "frequency": "once daily",           "duration": "30 days"},
            {"name": "Lisinopril",   "dosage": "10mg",   "frequency": "once daily",           "duration": "30 days"},
            {"name": "Aspirin",      "dosage": "75mg",   "frequency": "once daily",           "duration": "90 days"},
        ],
    ]

    extracted = DEMO_EXTRACTIONS[random.randint(0, len(DEMO_EXTRACTIONS) - 1)]
    drug_check = run_drug_check([m["name"] for m in extracted])

    return {
        "patientId":       req.patient_id,
        "extractedMeds":   extracted,
        "confidence":      round(random.uniform(0.82, 0.97), 2),
        "drugInteractions": drug_check,
        "processedAt":     datetime.utcnow().isoformat() + "Z",
        "model":           "MedPlus OCR v1.0 + Drug Interaction Engine v1.0",
        "note":            "OCR result is a demo simulation. Integrate Tesseract/Google Vision for production.",
    }
