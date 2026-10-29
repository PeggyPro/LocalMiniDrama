import request from '@/utils/request'
import { createVideoPlanningAPI } from './videoPlanningClient.js'

export const videoPlanningAPI = createVideoPlanningAPI(request)
