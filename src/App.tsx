import { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth,
  GoogleAuthProvider, 
  signInWithPopup, 
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { 
  getFirestore,
  collection, 
  addDoc, 
  onSnapshot, 
  query, 
  where, 
  doc, 
  updateDoc, 
  orderBy,
  Timestamp,
  getDoc,
  getDocFromServer,
  setDoc
} from 'firebase/firestore';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  BookOpen, 
  Trophy, 
  Users, 
  Upload, 
  Play, 
  CheckCircle2, 
  XCircle, 
  Coins, 
  LogOut,
  ChevronRight,
  Loader2,
  FileText,
  ShieldCheck,
  AlertCircle,
  LogIn,
  Camera
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as pdfjsLib from 'pdfjs-dist';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import firebaseConfig from '../firebase-applet-config.json';

// --- UTILS ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- FIREBASE SETUP ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
const auth = getAuth(app);

// --- GEMINI SERVICE ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function extractQuestionsFromImages(images: { data: string; mimeType: string }[]) {
  const parts = images.map(img => ({
    inlineData: {
      data: img.data,
      mimeType: img.mimeType
    }
  }));

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: {
      parts: [
        ...parts,
        {
          text: `Extract all questions and their correct answers from these homework assignment pages.
          For each question, check if there is a relevant diagram, image, or illustration associated with it on the same page.
          If there is a relevant visual element, provide its bounding box in normalized coordinates [ymin, xmin, ymax, xmax] (0-1000).
          Return a JSON array of objects.
          
          JSON Schema:
          {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "text": { "type": "string", "description": "The text of the question" },
                "correctAnswer": { "type": "string", "description": "The reference correct answer" },
                "pageIndex": { "type": "integer", "description": "The index of the image/page (0-indexed) where this question is found" },
                "boundingBox": { 
                  "type": "array", 
                  "items": { "type": "integer" },
                  "description": "Normalized [ymin, xmin, ymax, xmax] of the diagram, if any" 
                }
              },
              "required": ["text", "correctAnswer", "pageIndex"]
            }
          }`
        }
      ]
    },
    config: {
      responseMimeType: "application/json"
    }
  });

  return JSON.parse(response.text);
}

async function gradeAnswer(
  question: string, 
  correctAnswer: string, 
  studentAnswer: string, 
  questionImage?: string,
  studentImage?: string
) {
  const parts: any[] = [];

  if (questionImage) {
    const base64 = questionImage.includes('base64,') ? questionImage.split('base64,')[1] : questionImage;
    parts.push({
      inlineData: {
        data: base64,
        mimeType: "image/jpeg"
      }
    });
  }

  if (studentImage) {
    const base64 = studentImage.includes('base64,') ? studentImage.split('base64,')[1] : studentImage;
    parts.push({
      inlineData: {
        data: base64,
        mimeType: "image/jpeg"
      }
    });
  }

  parts.push({
    text: `Beoordeel het antwoord van de leerling op de volgende vraag.
    
    BELANGRIJKE REGELS:
    1. Voor TEKENVRAGEN (vragen waarbij de leerling iets moet tekenen):
       - Vergelijk de geüploade foto van de leerling met de vraag en het correcte antwoord.
       - Is de tekening correct en duidelijk?
    
    2. Voor REKENVRAGEN (vragen waarbij een berekening nodig is):
       - De leerling MOET de GGFIRE-methode gebruiken:
         - G: Gegeven
         - G: Gevraagd
         - F: Formule
         - I: Invullen
         - R: Rekenen
         - E: Eenheid
       - Als een van deze stappen ontbreekt, is het antwoord FOUT (isCorrect: false).
    
    3. Voor THEORIEVRAGEN: Beoordeel op inhoudelijke correctheid.
    
    4. Geef constructieve feedback in het Nederlands.
    
    Vraag: ${question}
    Correct Antwoord (Referentie): ${correctAnswer}
    Tekstueel Antwoord van Leerling: ${studentAnswer}
    ${studentImage ? "De leerling heeft ook een foto van hun tekening/uitwerking bijgevoegd." : ""}`
  });

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: { parts },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          isCorrect: { type: Type.BOOLEAN },
          feedback: { type: Type.STRING }
        },
        required: ["isCorrect", "feedback"]
      }
    }
  });

  return JSON.parse(response.text);
}

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: any;
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  return errInfo.error;
}

type View = 'login' | 'student' | 'teacher' | 'teacher-login';

interface Question {
  id: string;
  text: string;
  correctAnswer: string;
  order: number;
  image?: string; // Base64 image data
}

interface Student {
  id: string;
  name: string;
  points: number;
  joinedAt: any;
}

interface Submission {
  id: string;
  studentId: string;
  questionId: string;
  answer: string;
  studentImage?: string;
  bet: number;
  isCorrect: boolean;
  pointsAwarded: number;
  timestamp: any;
}

interface Session {
  id: string;
  name: string;
  active: boolean;
  createdAt: any;
  defaultPoints?: number;
}

export default function App() {
  const [view, setView] = useState<View>('login');
  const [studentName, setStudentName] = useState('');
  const [teacherPassword, setTeacherPassword] = useState('');
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [currentStudent, setCurrentStudent] = useState<Student | null>(null);
  const [newSessionName, setNewSessionName] = useState('');
  const [bulkPoints, setBulkPoints] = useState(5);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [teacherSessions, setTeacherSessions] = useState<Session[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Student state
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [studentAnswer, setStudentAnswer] = useState('');
  const [studentImage, setStudentImage] = useState<string | null>(null);
  const [bet, setBet] = useState(1);
  const [lastResult, setLastResult] = useState<{ isCorrect: boolean; feedback: string; pointsAwarded: number } | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'testing' | 'ok' | 'error'>('testing');
  const [user, setUser] = useState<User | null>(null);

  // Sync auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        // Create user doc if it doesn't exist
        const userRef = doc(db, 'users', u.uid);
        getDoc(userRef).then(docSnap => {
          if (!docSnap.exists()) {
            setDoc(userRef, {
              email: u.email,
              name: u.displayName,
              role: u.email === 'r.sies@onc.unicoz.nl' ? 'admin' : 'user',
              createdAt: Timestamp.now()
            });
          }
        });
      }
    });
    return () => unsubscribe();
  }, []);

  // Test connection on mount
  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, '_connection_test_', 'test'));
        setConnectionStatus('ok');
        console.log("Firebase connection successful");
      } catch (error: any) {
        console.error("Firebase connection failed:", error);
        if (error.message?.includes('the client is offline')) {
          setConnectionStatus('error');
          setError("Firebase is offline. Controleer de configuratie.");
        } else {
          // Some errors are expected if the doc doesn't exist, but we just want to see if we can reach the server
          setConnectionStatus('ok');
        }
      }
    };
    testConnection();
  }, []);

  // Fetch active sessions
  useEffect(() => {
    // Removed orderBy to avoid index requirement for now
    const q = query(collection(db, 'sessions'), where('active', '==', true));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const sessionList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Session));
      setSessions(sessionList);
    }, (err) => {
      const msg = handleFirestoreError(err, OperationType.LIST, 'sessions');
      setError(`Sessie lijst fout: ${msg}`);
    });
    return () => unsubscribe();
  }, []);

  // Fetch all sessions for teacher
  useEffect(() => {
    if (view !== 'teacher') return;
    const q = query(collection(db, 'sessions'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const sessionList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Session));
      setTeacherSessions(sessionList);
    }, (err) => {
      const msg = handleFirestoreError(err, OperationType.LIST, 'sessions');
      setError(`Sessie lijst fout: ${msg}`);
    });
    return () => unsubscribe();
  }, [view]);

  // Sync session data
  useEffect(() => {
    if (!currentSession) return;

    const qUnsub = onSnapshot(collection(db, `sessions/${currentSession.id}/questions`), (snapshot) => {
      const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Question)).sort((a, b) => a.order - b.order);
      setQuestions(list);
    });

    const sUnsub = onSnapshot(collection(db, `sessions/${currentSession.id}/students`), (snapshot) => {
      const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Student));
      setStudents(list);
      
      // Update local student object if it exists
      setCurrentStudent(prev => {
        if (!prev) return null;
        const updated = list.find(s => s.id === prev.id);
        return updated || prev;
      });
    });

    const subUnsub = onSnapshot(collection(db, `sessions/${currentSession.id}/submissions`), (snapshot) => {
      const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Submission));
      setSubmissions(list);
    });

    return () => {
      qUnsub();
      sUnsub();
      subUnsub();
    };
  }, [currentSession?.id]);

  const handleStudentLogin = async (session: Session) => {
    if (!studentName.trim()) return;
    setLoading(true);
    try {
      const startingPoints = session.defaultPoints ?? 5;
      const studentRef = await addDoc(collection(db, `sessions/${session.id}/students`), {
        name: studentName,
        points: startingPoints,
        joinedAt: Timestamp.now()
      });
      setCurrentSession(session);
      setCurrentStudent({ id: studentRef.id, name: studentName, points: startingPoints, joinedAt: new Date() });
      setView('student');
    } catch (err) {
      setError('Kon niet inloggen als leerling.');
    } finally {
      setLoading(false);
    }
  };

  const handleTeacherLogin = async () => {
    if (teacherPassword === 'W4ch7w00rd5135') {
      try {
        const provider = new GoogleAuthProvider();
        await signInWithPopup(auth, provider);
        setView('teacher');
        setError(null);
      } catch (err: any) {
        console.error('Login Error:', err);
        setError(`Inloggen mislukt: ${err.message}`);
      }
    } else {
      setError('Onjuist wachtwoord.');
    }
  };

  const createSession = async (name: string) => {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      console.log('Attempting to create session:', name);
      const sessionData = {
        name: name.trim(),
        active: false,
        createdAt: Timestamp.now(),
        defaultPoints: 5
      };
      const docRef = await addDoc(collection(db, 'sessions'), sessionData);
      console.log('Session created successfully with ID:', docRef.id);
      setCurrentSession({ id: docRef.id, ...sessionData, createdAt: new Date() });
      setNewSessionName('');
    } catch (err) {
      const msg = handleFirestoreError(err, OperationType.CREATE, 'sessions');
      setError(`Kon sessie niet aanmaken: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const toggleSessionActive = async (session: Session) => {
    setLoading(true);
    try {
      // If we're activating this session, deactivate all others first
      if (!session.active) {
        const otherActiveSessions = teacherSessions.filter(s => s.active && s.id !== session.id);
        for (const s of otherActiveSessions) {
          await updateDoc(doc(db, 'sessions', s.id), { active: false });
        }
      }
      
      await updateDoc(doc(db, 'sessions', session.id), { active: !session.active });
    } catch (err) {
      const msg = handleFirestoreError(err, OperationType.UPDATE, 'sessions');
      setError(`Sessie status wijzigen fout: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0] || !currentSession) return;
    setLoading(true);
    setError(null);
    try {
      const file = e.target.files[0];
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      
      const pageImages: { data: string; mimeType: string; width: number; height: number }[] = [];
      
      // Render each page to an image
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 }); // High res
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d')!;
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        await page.render({ canvasContext: context, viewport } as any).promise;
        const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
        pageImages.push({ 
          data: base64, 
          mimeType: 'image/jpeg',
          width: viewport.width,
          height: viewport.height
        });
      }

      const extracted = await extractQuestionsFromImages(pageImages.map(img => ({ data: img.data, mimeType: img.mimeType })));
      
      // Process questions and crop images if needed
      for (let i = 0; i < extracted.length; i++) {
        const qData = extracted[i];
        let croppedImage = undefined;

        if (qData.boundingBox && qData.pageIndex < pageImages.length) {
          const pageImg = pageImages[qData.pageIndex];
          const [ymin, xmin, ymax, xmax] = qData.boundingBox;
          
          // Normalized to pixel coordinates
          const x = (xmin / 1000) * pageImg.width;
          const y = (ymin / 1000) * pageImg.height;
          const w = ((xmax - xmin) / 1000) * pageImg.width;
          const h = ((ymax - ymin) / 1000) * pageImg.height;

          // Crop using canvas
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d')!;
          canvas.width = w;
          canvas.height = h;
          
          const img = new Image();
          await new Promise((resolve) => {
            img.onload = resolve;
            img.src = `data:${pageImg.mimeType};base64,${pageImg.data}`;
          });
          
          context.drawImage(img, x, y, w, h, 0, 0, w, h);
          croppedImage = canvas.toDataURL('image/jpeg', 0.9);
        }

        await addDoc(collection(db, `sessions/${currentSession.id}/questions`), {
          text: qData.text,
          correctAnswer: qData.correctAnswer,
          order: i,
          image: croppedImage || null
        });
      }
    } catch (err: any) {
      console.error('PDF Upload Error:', err);
      setError(`Fout: ${err.message || 'Kon PDF niet verwerken.'}`);
    } finally {
      setLoading(false);
    }
  };

  const assignPoints = async (studentId: string, amount: number) => {
    if (!currentSession) return;
    try {
      const studentRef = doc(db, `sessions/${currentSession.id}/students`, studentId);
      const studentDoc = await getDoc(studentRef);
      if (studentDoc.exists()) {
        const currentPoints = studentDoc.data().points || 0;
        await updateDoc(studentRef, { points: currentPoints + amount });
      }
    } catch (err) {
      setError('Kon punten niet toewijzen.');
    }
  };

  const assignBulkPoints = async () => {
    if (!currentSession) return;
    setLoading(true);
    try {
      // Update session default points
      const sessionRef = doc(db, 'sessions', currentSession.id);
      await updateDoc(sessionRef, { defaultPoints: bulkPoints });

      // Update current session state
      setCurrentSession(prev => prev ? { ...prev, defaultPoints: bulkPoints } : null);

      // Update all existing students if any
      if (students.length > 0) {
        const promises = students.map(student => {
          const studentRef = doc(db, `sessions/${currentSession.id}/students`, student.id);
          return updateDoc(studentRef, { points: bulkPoints });
        });
        await Promise.all(promises);
      }
      setError(null);
    } catch (err) {
      const msg = handleFirestoreError(err, OperationType.UPDATE, `sessions/${currentSession.id}`);
      setError(`Kon punten niet voor iedereen bijwerken: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const submitAnswer = async () => {
    if (!currentSession || !currentStudent || !questions[currentQuestionIndex]) return;
    if (currentStudent.points < bet) {
      setError('Niet genoeg punten!');
      return;
    }

    setLoading(true);
    try {
      const question = questions[currentQuestionIndex];
      const result = await gradeAnswer(question.text, question.correctAnswer, studentAnswer, question.image, studentImage || undefined);
      
      const pointsAwarded = result.isCorrect ? bet * 2 : 0;
      const pointChange = result.isCorrect ? bet : -bet;

      // Update student points
      const studentRef = doc(db, `sessions/${currentSession.id}/students`, currentStudent.id);
      try {
        await updateDoc(studentRef, { points: currentStudent.points + pointChange });
      } catch (err) {
        const msg = handleFirestoreError(err, OperationType.UPDATE, `sessions/${currentSession.id}/students/${currentStudent.id}`);
        setError(`Kon punten niet bijwerken: ${msg}`);
        return; // Stop if points update fails
      }

      // Record submission
      await addDoc(collection(db, `sessions/${currentSession.id}/submissions`), {
        sessionId: currentSession.id,
        studentId: currentStudent.id,
        questionId: question.id,
        answer: studentAnswer,
        studentImage: studentImage || null,
        bet,
        isCorrect: result.isCorrect,
        pointsAwarded,
        timestamp: Timestamp.now()
      });

      setLastResult({ ...result, pointsAwarded });
      setStudentAnswer('');
      setStudentImage(null);
      setBet(1);
    } catch (err) {
      const msg = handleFirestoreError(err, OperationType.WRITE, `sessions/${currentSession.id}/submissions`);
      setError(`Kon antwoord niet nakijken: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const nextQuestion = () => {
    setLastResult(null);
    setStudentImage(null);
    setCurrentQuestionIndex(prev => prev + 1);
  };

  const handleLogout = async () => {
    try {
      await auth.signOut();
      setCurrentSession(null);
      setCurrentStudent(null);
      setView('login');
      setError(null);
    } catch (err) {
      console.error('Logout Error:', err);
    }
  };

  // Render Helpers
  if (view === 'login') {
    return (
      <div className="min-h-screen bg-[#F5F5F0] flex flex-col items-center justify-center p-6 font-serif">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-white rounded-[32px] shadow-xl p-8 border border-[#5A5A40]/10"
        >
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 bg-[#5A5A40] rounded-full flex items-center justify-center text-white">
              <BookOpen size={32} />
            </div>
          </div>
          <h1 className="text-4xl text-center text-[#5A5A40] mb-2">Huiswerk Gokspel</h1>
          <p className="text-center text-[#5A5A40]/60 italic mb-8">Zet je kennis in en win punten!</p>

          <div className="space-y-6">
            <div>
              <label className="block text-sm font-semibold text-[#5A5A40] uppercase tracking-wider mb-2">Jouw Voornaam</label>
              <input 
                type="text" 
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
                placeholder="Bijv. Jan"
                className="w-full px-4 py-3 rounded-2xl border border-[#5A5A40]/20 focus:outline-none focus:ring-2 focus:ring-[#5A5A40]/50 bg-[#F5F5F0]/30"
              />
            </div>

            <div className="space-y-3">
              <label className="block text-sm font-semibold text-[#5A5A40] uppercase tracking-wider">Kies een Sessie</label>
              {sessions.length === 0 ? (
                <p className="text-center py-4 text-[#5A5A40]/40 italic">Geen actieve sessies gevonden...</p>
              ) : (
                <div className="space-y-2">
                  {sessions.map(session => (
                    <button
                      key={session.id}
                      onClick={() => handleStudentLogin(session)}
                      disabled={loading || !studentName}
                      className="w-full flex items-center justify-between px-4 py-4 rounded-2xl bg-[#F5F5F0] hover:bg-[#5A5A40] hover:text-white transition-all group disabled:opacity-50"
                    >
                      <span className="font-medium">{session.name}</span>
                      <ChevronRight className="opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-[#5A5A40]/10">
              <button 
                onClick={() => setView('teacher-login')}
                className="w-full py-3 text-[#5A5A40]/60 hover:text-[#5A5A40] transition-colors text-sm font-medium"
              >
                Inloggen als Docent
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  if (view === 'teacher-login') {
    return (
      <div className="min-h-screen bg-[#F5F5F0] flex flex-col items-center justify-center p-6 font-serif">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full bg-white rounded-[32px] shadow-xl p-8 border border-[#5A5A40]/10"
        >
          <button onClick={() => setView('login')} className="mb-6 text-[#5A5A40]/60 hover:text-[#5A5A40] flex items-center gap-2">
            <ChevronRight className="rotate-180" size={18} /> Terug
          </button>
          <h2 className="text-3xl text-[#5A5A40] mb-6">Docent Portaal</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-[#5A5A40] uppercase tracking-wider mb-2">Wachtwoord</label>
              <input 
                type="password" 
                value={teacherPassword}
                onChange={(e) => setTeacherPassword(e.target.value)}
                className="w-full px-4 py-3 rounded-2xl border border-[#5A5A40]/20 focus:outline-none focus:ring-2 focus:ring-[#5A5A40]/50"
              />
            </div>
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <button 
              onClick={handleTeacherLogin}
              className="w-full py-4 bg-[#5A5A40] text-white rounded-2xl font-bold hover:bg-[#4A4A30] transition-colors shadow-lg shadow-[#5A5A40]/20 flex items-center justify-center gap-2"
            >
              <LogIn size={20} />
              Inloggen met Google
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  if (view === 'teacher') {
    return (
      <div className="min-h-screen bg-[#F5F5F0] font-serif">
        <header className="bg-white border-b border-[#5A5A40]/10 px-8 py-4 flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-[#5A5A40] rounded-full flex items-center justify-center text-white">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h1 className="text-2xl text-[#5A5A40]">Docent Dashboard</h1>
              <div className="flex items-center gap-2">
                <div className={cn("w-2 h-2 rounded-full", connectionStatus === 'ok' ? "bg-green-500" : connectionStatus === 'testing' ? "bg-amber-500 animate-pulse" : "bg-red-500")} />
                <span className="text-[10px] uppercase tracking-widest text-[#5A5A40]/40">
                  {connectionStatus === 'ok' ? "Verbonden" : connectionStatus === 'testing' ? "Verbinden..." : "Offline"}
                </span>
              </div>
            </div>
          </div>
          <button onClick={handleLogout} className="p-2 text-[#5A5A40]/60 hover:text-red-500 transition-colors">
            <LogOut size={24} />
          </button>
        </header>

        {error && (
          <div className="max-w-7xl mx-auto px-8 pt-8">
            <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-4 rounded-2xl flex items-center gap-3">
              <AlertCircle size={20} />
              <p className="text-sm font-medium">{error}</p>
              <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">×</button>
            </div>
          </div>
        )}

        <main className="max-w-7xl mx-auto p-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column: Session & PDF */}
          <div className="lg:col-span-1 space-y-8">
            <section className="bg-white rounded-[32px] p-6 shadow-sm border border-[#5A5A40]/5">
              <h2 className="text-xl text-[#5A5A40] mb-4 flex items-center gap-2">
                <Play size={18} /> Sessie Beheer
              </h2>
              {!currentSession ? (
                <div className="space-y-6">
                  <div className="space-y-4">
                    <p className="text-xs font-bold uppercase tracking-widest text-[#5A5A40]/60">Nieuwe Sessie</p>
                    <input 
                      type="text" 
                      value={newSessionName}
                      onChange={(e) => setNewSessionName(e.target.value)}
                      placeholder="Sessie Naam (bijv. Geschiedenis H1)"
                      className="w-full px-4 py-3 rounded-xl border border-[#5A5A40]/10"
                      onKeyDown={(e) => e.key === 'Enter' && createSession(newSessionName)}
                    />
                    <button 
                      onClick={() => createSession(newSessionName)}
                      disabled={!newSessionName.trim() || loading}
                      className="w-full py-3 bg-[#5A5A40] text-white rounded-xl font-bold hover:bg-[#4A4A30] transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {loading ? <Loader2 className="animate-spin" size={18} /> : <Play size={18} />}
                      Sessie Starten
                    </button>
                  </div>

                  {teacherSessions.length > 0 && (
                    <div className="space-y-4 pt-6 border-t border-[#5A5A40]/10">
                      <p className="text-xs font-bold uppercase tracking-widest text-[#5A5A40]/60">Bestaande Sessies</p>
                      <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2">
                        {teacherSessions.map(s => (
                          <div 
                            key={s.id}
                            className={cn(
                              "w-full p-4 rounded-2xl text-left transition-all flex items-center justify-between group border",
                              currentSession?.id === s.id ? "bg-white border-[#5A5A40] shadow-sm" : "bg-[#F5F5F0] border-transparent hover:bg-[#E5E5E0]"
                            )}
                          >
                            <div 
                              className="flex-1 cursor-pointer"
                              onClick={() => {
                                setCurrentSession(s);
                                setBulkPoints(s.defaultPoints ?? 5);
                              }}
                            >
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-[#5A5A40]">{s.name}</span>
                                {s.active && (
                                  <span className="text-[10px] px-2 py-0.5 bg-green-100 text-green-700 rounded-full font-bold uppercase tracking-tighter">Actief</span>
                                )}
                              </div>
                              <p className="text-[10px] text-[#5A5A40]/40 uppercase tracking-widest mt-1">
                                {new Date(s.createdAt?.seconds * 1000).toLocaleDateString()}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => toggleSessionActive(s)}
                                disabled={loading}
                                className={cn(
                                  "p-2 rounded-xl transition-all",
                                  s.active 
                                    ? "bg-red-50 text-red-600 hover:bg-red-100" 
                                    : "bg-green-50 text-green-600 hover:bg-green-100"
                                )}
                                title={s.active ? "Sessie Stoppen" : "Sessie Starten"}
                              >
                                {s.active ? <XCircle size={18} /> : <Play size={18} />}
                              </button>
                              <ChevronRight size={16} className="text-[#5A5A40]/20 group-hover:text-[#5A5A40] transition-colors" />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="p-4 bg-[#F5F5F0] rounded-2xl">
                    <p className="text-sm text-[#5A5A40]/60 uppercase tracking-widest font-bold mb-1">Actieve Sessie</p>
                    <p className="text-lg font-medium">{currentSession.name}</p>
                  </div>
                  
                  <div className="pt-4 border-t border-[#5A5A40]/10">
                    <label className="block text-sm font-bold text-[#5A5A40] mb-2">Upload Huiswerk PDF</label>
                    <div className="relative">
                      <input 
                        type="file" 
                        accept=".pdf"
                        onChange={handleFileUpload}
                        className="hidden" 
                        id="pdf-upload"
                      />
                      <label 
                        htmlFor="pdf-upload"
                        className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-[#5A5A40]/20 rounded-2xl cursor-pointer hover:bg-[#F5F5F0] transition-colors"
                      >
                        <Upload className="text-[#5A5A40]/40 mb-2" />
                        <span className="text-sm font-medium text-[#5A5A40]/60">Klik om PDF te kiezen</span>
                      </label>
                    </div>
                    {loading && <div className="mt-2 flex items-center gap-2 text-sm text-[#5A5A40]/60"><Loader2 className="animate-spin" size={16} /> PDF Verwerken...</div>}
                  </div>
                </div>
              )}
            </section>

            <section className="bg-white rounded-[32px] p-6 shadow-sm border border-[#5A5A40]/5">
              <h2 className="text-xl text-[#5A5A40] mb-4 flex items-center gap-2">
                <FileText size={18} /> Vragen ({questions.length})
              </h2>
              <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
                {questions.map((q, i) => (
                  <div key={q.id} className="p-3 bg-[#F5F5F0] rounded-xl text-sm flex gap-3">
                    {q.image && (
                      <div className="w-16 h-16 rounded-lg overflow-hidden flex-shrink-0 border border-[#5A5A40]/10">
                        <img src={q.image} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-bold mb-1">Vraag {i + 1}</p>
                      <p className="text-[#5A5A40]/80 line-clamp-2">{q.text}</p>
                    </div>
                  </div>
                ))}
                {questions.length === 0 && <p className="text-center text-[#5A5A40]/40 italic py-8">Nog geen vragen geladen.</p>}
              </div>
            </section>
          </div>

          {/* Right Column: Students & Leaderboard */}
          <div className="lg:col-span-2 space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {/* Students List */}
              <section className="bg-white rounded-[32px] p-6 shadow-sm border border-[#5A5A40]/5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl text-[#5A5A40] flex items-center gap-2">
                    <Users size={18} /> Leerlingen ({students.length})
                  </h2>
                </div>

                {currentSession && (
                  <div className="mb-6 p-4 bg-[#F5F5F0] rounded-2xl border border-[#5A5A40]/10">
                    <p className="text-xs font-bold uppercase tracking-widest text-[#5A5A40]/60 mb-3">Startfiches Instellen</p>
                    <div className="flex gap-2">
                      <input 
                        type="number" 
                        value={bulkPoints}
                        onChange={(e) => setBulkPoints(parseInt(e.target.value) || 0)}
                        className="w-20 px-3 py-2 rounded-xl border border-[#5A5A40]/10 text-center font-bold"
                        min="0"
                      />
                      <button 
                        onClick={assignBulkPoints}
                        disabled={loading}
                        className="flex-1 py-2 bg-[#5A5A40] text-white rounded-xl text-xs font-bold hover:bg-[#4A4A30] transition-colors flex items-center justify-center gap-2"
                      >
                        {loading ? <Loader2 className="animate-spin" size={14} /> : <Coins size={14} />}
                        Stel in voor sessie
                      </button>
                    </div>
                    <p className="text-[10px] text-[#5A5A40]/40 mt-2 italic">
                      Dit stelt het startaantal in voor nieuwe leerlingen én overschrijft huidige punten van alle deelnemers.
                    </p>
                  </div>
                )}

                <div className="space-y-4">
                  {students.map(student => (
                    <div key={student.id} className="flex items-center justify-between p-4 bg-[#F5F5F0] rounded-2xl">
                      <div>
                        <p className="font-bold">{student.name}</p>
                        <p className="text-xs text-[#5A5A40]/60">{student.points} Punten</p>
                      </div>
                      <div className="flex gap-2">
                        <button 
                          onClick={() => assignPoints(student.id, 5)}
                          className="px-3 py-1 bg-[#5A5A40] text-white text-xs rounded-lg hover:bg-[#4A4A30]"
                        >
                          +5
                        </button>
                        <button 
                          onClick={() => assignPoints(student.id, 10)}
                          className="px-3 py-1 bg-[#5A5A40] text-white text-xs rounded-lg hover:bg-[#4A4A30]"
                        >
                          +10
                        </button>
                      </div>
                    </div>
                  ))}
                  {students.length === 0 && <p className="text-center text-[#5A5A40]/40 italic py-8">Wachten op leerlingen...</p>}
                </div>
              </section>

              {/* Live Status / Leaderboard */}
              <section className="bg-white rounded-[32px] p-6 shadow-sm border border-[#5A5A40]/5">
                <h2 className="text-xl text-[#5A5A40] mb-4 flex items-center gap-2">
                  <Trophy size={18} /> Live Standen
                </h2>
                <div className="space-y-4">
                  {students.sort((a, b) => b.points - a.points).map((student, i) => {
                    const latestSub = submissions.filter(s => s.studentId === student.id).sort((a, b) => b.timestamp.toMillis() - a.timestamp.toMillis())[0];
                    return (
                      <div key={student.id} className="flex items-center gap-4 p-4 bg-[#F5F5F0] rounded-2xl">
                        <span className="text-2xl font-bold text-[#5A5A40]/20">#{i + 1}</span>
                        <div className="flex-1">
                          <p className="font-bold">{student.name}</p>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{student.points} pts</span>
                            {latestSub && (
                              <span className={cn(
                                "text-[10px] px-2 py-0.5 rounded-full uppercase tracking-tighter",
                                latestSub.isCorrect ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                              )}>
                                {latestSub.isCorrect ? `+${latestSub.pointsAwarded}` : `-${latestSub.bet}`}
                              </span>
                            )}
                          </div>
                        </div>
                        {latestSub && (
                          <div className="text-right">
                            <p className="text-[10px] uppercase text-[#5A5A40]/40">Inzet</p>
                            <p className="font-mono font-bold text-[#5A5A40]">{latestSub.bet}</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (view === 'student' && currentSession && currentStudent) {
    if (questions.length === 0) {
      return (
        <div className="min-h-screen bg-[#F5F5F0] font-serif flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white rounded-[40px] p-10 shadow-xl border border-[#5A5A40]/5 text-center">
            <div className="w-20 h-20 bg-[#F5F5F0] rounded-full flex items-center justify-center mx-auto mb-6 text-[#5A5A40]">
              <Loader2 className="animate-spin" size={40} />
            </div>
            <h2 className="text-2xl text-[#5A5A40] mb-4">Wachten op de docent...</h2>
            <p className="text-[#5A5A40]/60">De docent is de vragen aan het voorbereiden. Zodra de PDF is geüpload, verschijnen de vragen hier automatisch.</p>
            <div className="mt-8 pt-8 border-t border-[#5A5A40]/5 flex items-center justify-between">
              <div className="text-left">
                <p className="text-[10px] uppercase tracking-widest text-[#5A5A40]/40">Ingelogd als</p>
                <p className="font-bold text-[#5A5A40]">{currentStudent.name}</p>
              </div>
              <button onClick={handleLogout} className="text-xs text-red-500 font-bold uppercase tracking-widest">Uitloggen</button>
            </div>
          </div>
        </div>
      );
    }

    if (currentQuestionIndex >= questions.length) {
      return (
        <div className="min-h-screen bg-[#F5F5F0] font-serif flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white rounded-[40px] p-10 shadow-xl border border-[#5A5A40]/5 text-center">
            <div className="w-20 h-20 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-6 text-green-600">
              <Trophy size={40} />
            </div>
            <h2 className="text-2xl text-[#5A5A40] mb-4">Goed gedaan!</h2>
            <p className="text-[#5A5A40]/60">Je hebt alle beschikbare vragen beantwoord. Wacht op verdere instructies van de docent.</p>
            <div className="mt-8 pt-8 border-t border-[#5A5A40]/5 flex items-center justify-between">
              <div className="text-left">
                <p className="text-[10px] uppercase tracking-widest text-[#5A5A40]/40">Jouw Score</p>
                <p className="font-bold text-[#5A5A40]">{currentStudent.points} Punten</p>
              </div>
              <button onClick={handleLogout} className="text-xs text-red-500 font-bold uppercase tracking-widest">Klaar</button>
            </div>
          </div>
        </div>
      );
    }

    const question = questions[currentQuestionIndex];

    return (
      <div className="min-h-screen bg-[#F5F5F0] font-serif p-6">
        <header className="max-w-4xl mx-auto flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <button onClick={handleLogout} className="p-2 text-[#5A5A40]/40 hover:text-[#5A5A40] transition-colors">
              <LogOut size={20} />
            </button>
            <div className="w-12 h-12 bg-white rounded-2xl shadow-sm flex items-center justify-center text-[#5A5A40] border border-[#5A5A40]/5">
              <BookOpen size={24} />
            </div>
            <div>
              <h1 className="text-xl text-[#5A5A40] leading-none mb-1">{currentSession.name}</h1>
              <p className="text-xs text-[#5A5A40]/60 italic">Ingelogd als {currentStudent.name}</p>
            </div>
          </div>
          <div className="bg-white px-6 py-3 rounded-2xl shadow-sm border border-[#5A5A40]/5 flex items-center gap-3">
            <Coins className="text-amber-500" size={20} />
            <span className="text-xl font-bold text-[#5A5A40]">{currentStudent.points}</span>
          </div>
        </header>

        <main className="max-w-4xl mx-auto">
          <AnimatePresence mode="wait">
            {!question ? (
              <motion.div 
                key="waiting"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white rounded-[40px] p-12 text-center shadow-xl border border-[#5A5A40]/5"
              >
                <div className="w-20 h-20 bg-[#F5F5F0] rounded-full flex items-center justify-center mx-auto mb-6">
                  <Loader2 className="animate-spin text-[#5A5A40]" size={40} />
                </div>
                <h2 className="text-3xl text-[#5A5A40] mb-4">Wachten op de docent...</h2>
                <p className="text-[#5A5A40]/60 italic max-w-md mx-auto">
                  Zodra de docent de vragen heeft geüpload en je punten heeft gegeven, kun je beginnen met spelen!
                </p>
              </motion.div>
            ) : lastResult ? (
              <motion.div 
                key="result"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-white rounded-[40px] p-12 text-center shadow-xl border border-[#5A5A40]/5"
              >
                <div className={cn(
                  "w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-8",
                  lastResult.isCorrect ? "bg-green-100 text-green-600" : "bg-red-100 text-red-600"
                )}>
                  {lastResult.isCorrect ? <CheckCircle2 size={48} /> : <XCircle size={48} />}
                </div>
                <h2 className="text-4xl text-[#5A5A40] mb-2">
                  {lastResult.isCorrect ? "Helemaal Correct!" : "Helaas..."}
                </h2>
                <p className="text-xl text-[#5A5A40]/60 mb-8 italic">
                  {lastResult.isCorrect 
                    ? `Je hebt ${lastResult.pointsAwarded} punten gewonnen!` 
                    : `Je hebt ${bet} punten verloren.`}
                </p>
                
                <div className="bg-[#F5F5F0] p-6 rounded-3xl mb-8 text-left">
                  <p className="text-xs font-bold uppercase tracking-widest text-[#5A5A40]/40 mb-2">Feedback van de AI</p>
                  <p className="text-[#5A5A40]">{lastResult.feedback}</p>
                </div>

                <button 
                  onClick={nextQuestion}
                  className="px-12 py-4 bg-[#5A5A40] text-white rounded-2xl font-bold hover:bg-[#4A4A30] transition-transform hover:scale-105 shadow-lg"
                >
                  Volgende Vraag
                </button>
              </motion.div>
            ) : (
              <motion.div 
                key="question"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white rounded-[40px] p-10 shadow-xl border border-[#5A5A40]/5"
              >
                <div className="flex items-center justify-between mb-8">
                  <span className="text-xs font-bold uppercase tracking-[0.2em] text-[#5A5A40]/40">Vraag {currentQuestionIndex + 1} van {questions.length}</span>
                  <div className="h-1 flex-1 mx-8 bg-[#F5F5F0] rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-[#5A5A40] transition-all duration-500" 
                      style={{ width: `${((currentQuestionIndex + 1) / questions.length) * 100}%` }}
                    />
                  </div>
                </div>

                <h2 className="text-2xl text-[#5A5A40] mb-8 leading-relaxed">
                  {question.text}
                </h2>

                {question.image && (
                  <div className="mb-8 rounded-3xl overflow-hidden border border-[#5A5A40]/10 shadow-sm">
                    <img 
                      src={question.image} 
                      alt="Diagram bij vraag" 
                      className="w-full h-auto object-contain max-h-[400px]"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                )}

                <div className="space-y-8">
                  {question.text.toLowerCase().includes('teken') && (
                    <div className="p-6 bg-[#F5F5F0]/50 rounded-3xl border border-[#5A5A40]/10">
                      <label className="block text-sm font-bold text-[#5A5A40] uppercase tracking-widest mb-4 flex items-center gap-2">
                        <Camera size={18} /> Foto van je tekening
                      </label>
                      <div className="flex flex-col gap-4">
                        {!studentImage ? (
                          <div className="relative">
                            <input 
                              type="file" 
                              accept="image/*" 
                              capture="environment"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) {
                                  const reader = new FileReader();
                                  reader.onloadend = () => setStudentImage(reader.result as string);
                                  reader.readAsDataURL(file);
                                }
                              }}
                              className="hidden"
                              id="student-photo-upload"
                            />
                            <label 
                              htmlFor="student-photo-upload"
                              className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-[#5A5A40]/20 rounded-2xl cursor-pointer hover:bg-[#5A5A40]/5 transition-colors"
                            >
                              <Upload className="text-[#5A5A40]/40 mb-2" size={24} />
                              <span className="text-sm text-[#5A5A40]/60">Klik om een foto te maken of te uploaden</span>
                            </label>
                          </div>
                        ) : (
                          <div className="relative rounded-2xl overflow-hidden border border-[#5A5A40]/10 group">
                            <img src={studentImage} alt="Jouw tekening" className="w-full h-auto max-h-[300px] object-contain" />
                            <button 
                              onClick={() => setStudentImage(null)}
                              className="absolute top-2 right-2 p-2 bg-red-500 text-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <XCircle size={20} />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-bold text-[#5A5A40] uppercase tracking-widest mb-4">
                      {question.text.toLowerCase().includes('teken') ? "Toelichting (optioneel)" : "Jouw Antwoord"}
                    </label>
                    <textarea 
                      rows={question.text.toLowerCase().includes('teken') ? 4 : 8}
                      value={studentAnswer}
                      onChange={(e) => setStudentAnswer(e.target.value)}
                      placeholder={question.text.toLowerCase().includes('teken') ? "Leg hier eventueel je tekening uit..." : "Typ hier je antwoord (gebruik voor rekenvragen de GGFIRE-methode: Gegeven, Gevraagd, Formule, Invullen, Rekenen, Eenheid)..."}
                      className="w-full p-6 rounded-3xl bg-[#F5F5F0]/50 border border-[#5A5A40]/10 focus:outline-none focus:ring-2 focus:ring-[#5A5A40]/30 transition-all resize-none text-lg"
                    />
                    {!question.text.toLowerCase().includes('teken') && (
                      <p className="mt-2 text-xs text-[#5A5A40]/60 italic">
                        Tip: Bij rekenvragen is de GGFIRE-methode verplicht voor een goedkeuring.
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col md:flex-row items-center justify-between gap-6 pt-6 border-t border-[#5A5A40]/5">
                    <div className="flex items-center gap-4">
                      <span className="text-sm font-bold text-[#5A5A40] uppercase tracking-widest">Inzet:</span>
                      <div className="flex gap-2">
                        {[1, 2, 3].map(val => (
                          <button
                            key={val}
                            onClick={() => setBet(val)}
                            disabled={currentStudent.points < val}
                            className={cn(
                              "w-12 h-12 rounded-xl border-2 font-bold transition-all flex items-center justify-center",
                              bet === val 
                                ? "bg-[#5A5A40] border-[#5A5A40] text-white scale-110 shadow-md" 
                                : "border-[#5A5A40]/20 text-[#5A5A40] hover:border-[#5A5A40]/50",
                              currentStudent.points < val && "opacity-20 cursor-not-allowed"
                            )}
                          >
                            {val}
                          </button>
                        ))}
                      </div>
                    </div>

                    <button 
                      onClick={submitAnswer}
                      disabled={loading || (!studentAnswer.trim() && !studentImage) || currentStudent.points < bet}
                      className="w-full md:w-auto px-12 py-4 bg-[#5A5A40] text-white rounded-2xl font-bold hover:bg-[#4A4A30] transition-all disabled:opacity-50 shadow-lg flex items-center justify-center gap-2"
                    >
                      {loading ? <Loader2 className="animate-spin" /> : "Antwoord Indienen"}
                    </button>
                  </div>
                  {error && <p className="text-red-500 text-center text-sm">{error}</p>}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    );
  }

  return null;
}
